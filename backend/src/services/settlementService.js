import Decimal from 'decimal.js'
import { pool } from '../config/db.js'
import { httpError } from '../middleware/errors.js'
import { createJournal } from './accountingService.js'
import { withTransaction } from './transactionService.js'

// Formas de pago que dejan un saldo pendiente de cobrar (ventas) o de pagar (compras).
const CREDIT_METHODS = ['CUENTA_CORRIENTE', 'PAGARE', 'CHEQUE_DIFERIDO']

const CONFIG = {
  COBRO: { side: 'venta', operationColumn: 'venta_id', sequence: 'numero_recibo_seq', prefix: 'RC' },
  PAGO: { side: 'compra', operationColumn: 'compra_id', sequence: 'numero_orden_pago_seq', prefix: 'OP' },
}

function configFor(type) {
  const config = CONFIG[type]
  if (!config) throw httpError(400, 'El tipo debe ser COBRO o PAGO.')
  return config
}

// Saldo pendiente = importe del renglón a crédito (más recargo) menos lo ya cancelado.
const PENDING_SQL = (config) => `
  SELECT po.id AS pago_operacion_id, o.id AS operacion_id, o.numero_comprobante, o.tipo_comprobante, o.fecha AS fecha_operacion,
         t.razon_social AS tercero, fp.nombre AS forma_pago,
         (po.importe + po.recargo_importe) AS total,
         COALESCE(SUM(c.importe), 0) AS cancelado,
         (po.importe + po.recargo_importe - COALESCE(SUM(c.importe), 0)) AS pendiente
  FROM pagos_operacion po
  JOIN formas_pago fp ON fp.id = po.forma_pago_id
  JOIN ${config.side === 'venta' ? 'ventas' : 'compras'} o ON o.id = po.${config.operationColumn}
  JOIN ${config.side === 'venta' ? 'clientes' : 'proveedores'} t ON t.id = o.${config.side === 'venta' ? 'cliente_id' : 'proveedor_id'}
  LEFT JOIN cancelaciones c ON c.pago_operacion_id = po.id
  WHERE fp.codigo = ANY($1)`

export async function listPending(type) {
  const config = configFor(type)
  const { rows } = await pool.query(
    `${PENDING_SQL(config)}
     GROUP BY po.id, o.id, t.id, fp.id
     HAVING (po.importe + po.recargo_importe - COALESCE(SUM(c.importe), 0)) > 0
     ORDER BY o.fecha, o.id`, [CREDIT_METHODS],
  )
  return rows
}

export async function listSettlements(type) {
  const config = configFor(type)
  const { rows } = await pool.query(
    `SELECT c.id, c.numero, c.fecha, c.importe, c.observaciones, mp.nombre AS medio,
            o.numero_comprobante, t.razon_social AS tercero, fp.nombre AS forma_origen
     FROM cancelaciones c
     JOIN pagos_operacion po ON po.id = c.pago_operacion_id
     JOIN formas_pago fp ON fp.id = po.forma_pago_id
     JOIN formas_pago mp ON mp.id = c.forma_pago_id
     JOIN ${config.side === 'venta' ? 'ventas' : 'compras'} o ON o.id = po.${config.operationColumn}
     JOIN ${config.side === 'venta' ? 'clientes' : 'proveedores'} t ON t.id = o.${config.side === 'venta' ? 'cliente_id' : 'proveedor_id'}
     WHERE c.tipo = $1
     ORDER BY c.fecha DESC, c.id DESC LIMIT 200`, [type],
  )
  return rows
}

// Registra un cobro o pago contra un renglón pendiente y genera el asiento de cancelación.
export async function createSettlement(type, input, userId) {
  const config = configFor(type)
  const amount = new Decimal(String(input.importe ?? ''))
  if (!amount.isFinite() || amount.lte(0)) throw httpError(400, 'El importe debe ser mayor a cero.')
  const importe = amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  if (!input.fecha || !Number(input.pago_operacion_id) || !Number(input.forma_pago_id)) {
    throw httpError(400, 'Fecha, comprobante pendiente y medio de pago son obligatorios.')
  }

  return withTransaction(async (client) => {
    const { rows: pendingRows } = await client.query(
      `SELECT po.id, po.importe, po.recargo_importe, o.numero_comprobante,
              fp.codigo, fp.cuenta_${config.side}_id AS cuenta_id
       FROM pagos_operacion po
       JOIN formas_pago fp ON fp.id = po.forma_pago_id
       JOIN ${config.side === 'venta' ? 'ventas' : 'compras'} o ON o.id = po.${config.operationColumn}
       WHERE po.id = $1 FOR UPDATE OF po`, [input.pago_operacion_id],
    )
    const line = pendingRows[0]
    if (!line || !CREDIT_METHODS.includes(line.codigo)) {
      throw httpError(404, `El saldo indicado no corresponde a ${type === 'COBRO' ? 'una venta' : 'una compra'} a crédito.`)
    }
    const { rows: settledRows } = await client.query(
      'SELECT COALESCE(SUM(importe), 0) AS total FROM cancelaciones WHERE pago_operacion_id = $1', [line.id],
    )
    const pending = new Decimal(line.importe).plus(line.recargo_importe).minus(settledRows[0].total)
    if (importe.gt(pending)) {
      throw httpError(400, `El importe supera el saldo pendiente (${pending.toFixed(2)}).`)
    }

    const { rows: methodRows } = await client.query(
      `SELECT id, codigo, nombre, cuenta_${config.side}_id AS cuenta_id FROM formas_pago WHERE id = $1 AND activo = TRUE`,
      [input.forma_pago_id],
    )
    const method = methodRows[0]
    if (!method?.cuenta_id || CREDIT_METHODS.includes(method.codigo)) {
      throw httpError(400, `El medio de ${type === 'COBRO' ? 'cobro' : 'pago'} no es válido; use efectivo, banco o cheque.`)
    }

    const { rows } = await client.query(
      `INSERT INTO cancelaciones (tipo, numero, pago_operacion_id, forma_pago_id, fecha, importe, observaciones, creado_por)
       VALUES ($1, $2 || ' 0001-' || LPAD(nextval('${config.sequence}')::TEXT, 8, '0'), $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [type, config.prefix, line.id, method.id, input.fecha, importe.toFixed(2),
        String(input.observaciones ?? '').trim().slice(0, 240) || null, userId],
    )
    const settlement = rows[0]

    // Cobro: entra dinero y baja el crédito a cobrar. Pago: sale dinero y baja la deuda.
    const moneyLine = type === 'COBRO'
      ? { cuentaId: method.cuenta_id, debe: importe }
      : { cuentaId: method.cuenta_id, haber: importe }
    const debtLine = type === 'COBRO'
      ? { cuentaId: line.cuenta_id, haber: importe }
      : { cuentaId: line.cuenta_id, debe: importe }
    await createJournal(client, {
      fecha: input.fecha,
      descripcion: `${type === 'COBRO' ? 'Cobro' : 'Pago'} ${settlement.numero} s/ factura ${line.numero_comprobante}`,
      tipo: type, reference: { cancelacionId: settlement.id }, userId, lines: [moneyLine, debtLine],
    })
    return settlement
  })
}
