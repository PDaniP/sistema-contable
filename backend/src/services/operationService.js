import Decimal from 'decimal.js'
import { httpError } from '../middleware/errors.js'
import { createJournal, getAccountIds } from './accountingService.js'
import { withTransaction } from './transactionService.js'

const IVA_RATE = new Decimal('0.21')

// Convierte importes a Decimal y centavos para evitar errores de redondeo de Number.
function money(value, label) {
  try {
    const amount = new Decimal(String(value))
    if (!amount.isFinite() || amount.isNegative()) throw new Error()
    return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  } catch {
    throw httpError(400, `${label} debe ser un importe válido mayor o igual a cero.`)
  }
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'La operación debe incluir al menos un producto.')
  }
  const productIds = new Set()
  for (const item of items) {
    const id = Number(item.producto_id)
    const quantity = Number(item.cantidad)
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
      throw httpError(400, 'Cada producto debe tener un identificador y una cantidad entera mayor a cero.')
    }
    if (productIds.has(id)) throw httpError(400, 'No repita productos; consolide las cantidades en un solo renglón.')
    productIds.add(id)
  }
  // El orden estable reduce conflictos si dos operaciones bloquean varios productos.
  return [...items].sort((left, right) => Number(left.producto_id) - Number(right.producto_id))
}

// Bloquea filas hasta confirmar la transaccion para impedir que ventas concurrentes usen el mismo stock.
async function lockProducts(client, items) {
  const products = new Map()
  for (const item of items) {
    const { rows } = await client.query(
      'SELECT id, nombre, stock, costo_unitario, precio_venta FROM productos WHERE id = $1 AND activo = TRUE FOR UPDATE',
      [item.producto_id],
    )
    if (!rows[0]) throw httpError(404, `No existe el producto ${item.producto_id}.`)
    products.set(Number(item.producto_id), rows[0])
  }
  return products
}

// Calcula neto, IVA y costo de cada renglon con precios decimales exactos.
function calculateLines(items, products, isSale, taxRate = IVA_RATE) {
  return items.map((item) => {
    const product = products.get(Number(item.producto_id))
    const unitPrice = item.precio_unitario === undefined
      ? new Decimal(isSale ? product.precio_venta : product.costo_unitario)
      : money(item.precio_unitario, 'El precio unitario')
    const net = unitPrice.mul(item.cantidad).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    const tax = net.mul(taxRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    return {
      productoId: Number(item.producto_id),
      cantidad: Number(item.cantidad),
      precioUnitario: unitPrice,
      costoUnitario: new Decimal(product.costo_unitario),
      neto: net,
      iva: tax,
      total: net.plus(tax),
    }
  })
}

function sum(lines, property) {
  return lines.reduce((total, line) => total.plus(line[property]), new Decimal(0))
}

async function validatePayments(client, payments, total, operation) {
  if (!Array.isArray(payments) || payments.length === 0) {
    throw httpError(400, 'Debe indicar al menos una forma de pago.')
  }
  const normalized = payments.map((payment) => {
    const pct = new Decimal(payment.recargo_porcentaje || 0)
    if (!pct.isFinite() || pct.isNegative() || pct.gt(1000)) throw httpError(400, 'El recargo debe ser un porcentaje entre 0 y 1000.')
    return {
      formaPagoId: Number(payment.forma_pago_id),
      importe: money(payment.importe, 'El importe del pago'),
      recargoPorcentaje: pct,
    }
  })
  if (normalized.some((payment) => !Number.isInteger(payment.formaPagoId) || payment.formaPagoId <= 0
    || payment.importe.isZero())) {
    throw httpError(400, 'Cada pago debe incluir una forma válida y un importe mayor a cero.')
  }
  if (!sum(normalized, 'importe').equals(total)) {
    throw httpError(400, 'La suma de las formas de pago debe coincidir con el total de la operación.')
  }

  // La cuenta asociada depende de si se cobra una venta o se paga una compra.
  for (const payment of normalized) {
    const { rows } = await client.query(
      `SELECT fp.id, fp.cuenta_${operation}_id AS cuenta_id
       FROM formas_pago fp WHERE fp.id = $1 AND fp.activo = TRUE`,
      [payment.formaPagoId],
    )
    if (!rows[0]?.cuenta_id) throw httpError(400, 'La forma de pago no es válida para esta operación.')
    payment.cuentaId = rows[0].cuenta_id
    // El recargo se suma al importe efectivamente cobrado/pagado; la factura conserva su total.
    payment.recargo = payment.importe.mul(payment.recargoPorcentaje).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    payment.cobrado = payment.importe.plus(payment.recargo)
  }
  return normalized
}

async function savePayments(client, payments, saleId, purchaseId) {
  for (const payment of payments) {
    await client.query(
      `INSERT INTO pagos_operacion (venta_id, compra_id, forma_pago_id, importe, recargo_porcentaje, recargo_importe)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [saleId ?? null, purchaseId ?? null, payment.formaPagoId, payment.importe.toFixed(2),
        payment.recargoPorcentaje.toFixed(2), payment.recargo.toFixed(2)],
    )
  }
}

async function writeStockMovement(client, { product, item, date, type, referenceId, unitCost }) {
  const previousStock = Number(product.stock)
  const nextStock = type === 'VENTA' ? previousStock - item.cantidad : previousStock + item.cantidad
  if (nextStock < 0) throw httpError(400, 'No existe stock suficiente para realizar la venta.')
  await client.query(
    'UPDATE productos SET stock = $1, costo_unitario = COALESCE($2, costo_unitario), updated_at = NOW() WHERE id = $3',
    [nextStock, unitCost?.toFixed(2) ?? null, product.id],
  )
  await client.query(
    `INSERT INTO movimientos_stock
       (producto_id, fecha, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, venta_id, compra_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [product.id, date, type, item.cantidad, previousStock, nextStock,
      type === 'VENTA' ? referenceId : null, type === 'COMPRA' ? referenceId : null],
  )
}

// Venta: valida cliente/stock, calcula comprobante e IVA, registra pagos y asientos de venta y CMV.
export async function createSale(input, userId) {
  const items = validateItems(input.items)
  if (!input.cliente_id || !input.fecha) throw httpError(400, 'Cliente y fecha son obligatorios.')

  return withTransaction(async (client) => {
    const { rows: clientRows } = await client.query(
      'SELECT id, condicion_iva FROM clientes WHERE id = $1 AND activo = TRUE', [input.cliente_id],
    )
    const customer = clientRows[0]
    if (!customer) throw httpError(404, 'El cliente no existe o está inactivo.')

    const products = await lockProducts(client, items)
    for (const item of items) {
      if (Number(products.get(Number(item.producto_id)).stock) < Number(item.cantidad)) {
        throw httpError(400, 'No existe stock suficiente para realizar la venta.')
      }
    }

    // Un emisor monotributista siempre factura C sin IVA; si no, la condición del cliente define A o B.
    const monotributo = input.emisor_monotributista === true
    // Un responsable inscripto o un monotributista receptor recibe Factura A; el resto, Factura B.
    const invoiceType = monotributo ? 'FACTURA_C'
      : ['RESPONSABLE_INSCRIPTO', 'MONOTRIBUTISTA'].includes(customer.condicion_iva) ? 'FACTURA_A' : 'FACTURA_B'
    // La Factura C no discrimina IVA en el comprobante, pero el IVA se calcula y se liquida igual.
    const lines = calculateLines(items, products, true, IVA_RATE)
    const net = sum(lines, 'neto')
    const tax = sum(lines, 'iva')
    const total = net.plus(tax)
    const payments = await validatePayments(client, input.pagos, total, 'venta')
    const { rows } = await client.query(
      `INSERT INTO ventas (cliente_id, fecha, tipo_comprobante, neto, iva, total, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [customer.id, input.fecha, invoiceType, net.toFixed(2), tax.toFixed(2), total.toFixed(2), userId],
    )
    const sale = rows[0]
    // El snapshot impide que compras futuras alteren el costo historico de esta venta.
    const cost = sum(lines.map((line) => ({ costo: line.costoUnitario.mul(line.cantidad) })), 'costo')

    for (const line of lines) {
      await client.query(
        `INSERT INTO detalle_ventas
           (venta_id, producto_id, cantidad, precio_unitario, costo_unitario_snapshot, neto, iva, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [sale.id, line.productoId, line.cantidad, line.precioUnitario.toFixed(2),
          line.costoUnitario.toFixed(2), line.neto.toFixed(2), line.iva.toFixed(2), line.total.toFixed(2)],
      )
      await writeStockMovement(client, {
        product: products.get(line.productoId), item: line, date: input.fecha, type: 'VENTA', referenceId: sale.id,
      })
    }

    await savePayments(client, payments, sale.id, null)
    const accounts = await getAccountIds(client)
    const surcharge = sum(payments, 'recargo')
    if (!surcharge.isZero() && !accounts['4.2.01']) {
      throw httpError(500, 'Falta la cuenta 4.2.01; ejecute database/migrations/003_cheque_diferido_recargos.sql.')
    }
    const invoiceLines = payments.map((payment) => ({ cuentaId: payment.cuentaId, debe: payment.cobrado }))
    invoiceLines.push(
      { cuentaId: accounts['4.1.01'], haber: net },
      { cuentaId: accounts['2.1.04'], haber: tax },
      { cuentaId: accounts['4.2.01'], haber: surcharge },
    )
    await createJournal(client, {
      fecha: input.fecha, descripcion: `Venta según ${invoiceType} ${sale.numero_comprobante}`,
      tipo: 'VENTA', reference: { ventaId: sale.id }, userId, lines: invoiceLines,
    })

    const costLines = []
    if (!cost.isZero()) {
      costLines.push(
        { cuentaId: accounts['5.1.01'], debe: cost },
        { cuentaId: accounts['1.1.03'], haber: cost },
      )
    }
    if (costLines.length) {
      await createJournal(client, {
        fecha: input.fecha, descripcion: `CMV de venta ${sale.numero_comprobante}`,
        tipo: 'CMV', reference: { ventaId: sale.id }, userId, lines: costLines,
      })
    }
    return { ...sale, costo_mercaderias_vendidas: cost.toFixed(2) }
  })
}

// Compra: registra factura, aumenta stock/costo, guarda pagos y contabiliza IVA credito.
export async function createPurchase(input, userId) {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw httpError(400, 'La operación debe incluir al menos un producto.')
  }
  // Los renglones libres solo llevan descripción y precio: no tocan el catálogo ni el stock.
  const freeInput = input.items.filter((item) => !item.producto_id)
  const catalogInput = input.items.filter((item) => item.producto_id)
  const freeItems = freeInput.map((item) => {
    const description = String(item.descripcion ?? '').trim()
    const quantity = Number(item.cantidad)
    if (!description || description.length > 180 || !Number.isInteger(quantity) || quantity <= 0) {
      throw httpError(400, 'Cada renglón libre necesita una descripción (hasta 180 caracteres) y una cantidad entera mayor a cero.')
    }
    return { descripcion: description, cantidad: quantity, precioUnitario: money(item.precio_unitario, 'El precio unitario') }
  })
  const items = catalogInput.length ? validateItems(catalogInput) : []
  if (!input.proveedor_id || !input.fecha || !input.numero_comprobante) {
    throw httpError(400, 'Proveedor, fecha y número de comprobante son obligatorios.')
  }

  const invoiceType = input.tipo_comprobante ?? 'FACTURA_A'
  if (!['FACTURA_A', 'FACTURA_B'].includes(invoiceType)) {
    throw httpError(400, 'El tipo de comprobante debe ser FACTURA_A o FACTURA_B.')
  }

  return withTransaction(async (client) => {
    const { rows: providerRows } = await client.query(
      'SELECT id FROM proveedores WHERE id = $1 AND activo = TRUE', [input.proveedor_id],
    )
    if (!providerRows[0]) throw httpError(404, 'El proveedor no existe o está inactivo.')

    const products = await lockProducts(client, items)
    // La Factura B no discrimina IVA, por lo que no genera crédito fiscal.
    const taxRate = invoiceType === 'FACTURA_A' ? IVA_RATE : new Decimal(0)
    const lines = calculateLines(items, products, false, taxRate)
    const freeLines = freeItems.map((item) => {
      const net = item.precioUnitario.mul(item.cantidad).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      const tax = net.mul(taxRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      return { ...item, neto: net, iva: tax, total: net.plus(tax) }
    })
    const stockNet = sum(lines, 'neto')
    const freeNet = sum(freeLines, 'neto')
    const net = stockNet.plus(freeNet)
    const tax = sum(lines, 'iva').plus(sum(freeLines, 'iva'))
    const total = net.plus(tax)
    const payments = await validatePayments(client, input.pagos, total, 'compra')
    const { rows } = await client.query(
      `INSERT INTO compras (proveedor_id, fecha, tipo_comprobante, numero_comprobante, neto, iva, total, creado_por)
       VALUES ($1, $2, $8, $3, $4, $5, $6, $7) RETURNING *`,
      [input.proveedor_id, input.fecha, String(input.numero_comprobante).trim(),
        net.toFixed(2), tax.toFixed(2), total.toFixed(2), userId, invoiceType],
    )
    const purchase = rows[0]

    for (const line of lines) {
      await client.query(
        `INSERT INTO detalle_compras (compra_id, producto_id, cantidad, precio_unitario, neto, iva, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [purchase.id, line.productoId, line.cantidad, line.precioUnitario.toFixed(2),
          line.neto.toFixed(2), line.iva.toFixed(2), line.total.toFixed(2)],
      )
      await writeStockMovement(client, {
        product: products.get(line.productoId), item: line, date: input.fecha,
        type: 'COMPRA', referenceId: purchase.id, unitCost: line.precioUnitario,
      })
    }
    for (const line of freeLines) {
      await client.query(
        `INSERT INTO detalle_compras (compra_id, producto_id, descripcion, cantidad, precio_unitario, neto, iva, total)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
        [purchase.id, line.descripcion, line.cantidad, line.precioUnitario.toFixed(2),
          line.neto.toFixed(2), line.iva.toFixed(2), line.total.toFixed(2)],
      )
    }

    await savePayments(client, payments, null, purchase.id)
    const accounts = await getAccountIds(client)
    if (!freeNet.isZero() && !accounts['5.2.01']) {
      throw httpError(500, 'Falta la cuenta 5.2.01; ejecute database/migrations/001_compras_renglones_libres.sql.')
    }
    const surcharge = sum(payments, 'recargo')
    if (!surcharge.isZero() && !accounts['5.2.02']) {
      throw httpError(500, 'Falta la cuenta 5.2.02; ejecute database/migrations/003_cheque_diferido_recargos.sql.')
    }
    const purchaseLines = [
      { cuentaId: accounts['1.1.03'], debe: stockNet },
      // Los renglones libres no ingresan a inventario: se imputan a gastos.
      { cuentaId: accounts['5.2.01'], debe: freeNet },
      { cuentaId: accounts['1.1.05'], debe: tax },
      { cuentaId: accounts['5.2.02'], debe: surcharge },
      ...payments.map((payment) => ({ cuentaId: payment.cuentaId, haber: payment.cobrado })),
    ]
    await createJournal(client, {
      fecha: input.fecha, descripcion: `Compra según factura ${purchase.numero_comprobante}`,
      tipo: 'COMPRA', reference: { compraId: purchase.id }, userId, lines: purchaseLines,
    })
    return purchase
  })
}