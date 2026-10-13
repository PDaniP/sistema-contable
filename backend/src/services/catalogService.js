import Decimal from 'decimal.js'
import { pool } from '../config/db.js'
import { httpError } from '../middleware/errors.js'

// Lista blanca de tablas y campos: reutiliza CRUD sin aceptar identificadores SQL del cliente.
const catalogs = {
  productos: {
    table: 'productos',
    fields: ['nombre', 'descripcion', 'stock', 'costo_unitario', 'precio_venta'],
    required: ['nombre', 'costo_unitario'],
  },
  clientes: {
    table: 'clientes',
    fields: ['razon_social', 'identificacion', 'domicilio', 'condicion_iva'],
    required: ['razon_social', 'condicion_iva'],
  },
  proveedores: {
    table: 'proveedores',
    fields: ['razon_social', 'cuit', 'domicilio', 'condicion_iva'],
    required: ['razon_social', 'cuit'],
  },
}

function getCatalog(name) {
  const catalog = catalogs[name]
  if (!catalog) throw httpError(404, 'Catálogo inexistente.')
  return catalog
}

function normalizeInput(name, input) {
  const catalog = getCatalog(name)
  const values = Object.fromEntries(catalog.fields
    .filter((field) => input[field] !== undefined)
    .map((field) => [field, input[field]]))

  // Cada catalogo aplica sus validaciones de dominio antes de preparar la consulta.
  if (name === 'productos') {
    if (values.nombre !== undefined && !String(values.nombre).trim()) {
      throw httpError(400, 'El nombre del producto es obligatorio.')
    }
    for (const field of ['stock', 'costo_unitario', 'precio_venta']) {
      if (values[field] !== undefined && (!Number.isFinite(Number(values[field])) || Number(values[field]) < 0)) {
        throw httpError(400, `${field} debe ser un valor mayor o igual a cero.`)
      }
    }
    if (values.stock !== undefined && !Number.isInteger(Number(values.stock))) {
      throw httpError(400, 'El stock debe ser un número entero.')
    }
  }

  if (name === 'clientes') {
    if (values.razon_social !== undefined && !String(values.razon_social).trim()) {
      throw httpError(400, 'La razón social es obligatoria.')
    }
    if (values.condicion_iva !== undefined
      && !['RESPONSABLE_INSCRIPTO', 'MONOTRIBUTISTA', 'CONSUMIDOR_FINAL'].includes(values.condicion_iva)) {
      throw httpError(400, 'La condición de IVA del cliente no es válida.')
    }
  }

  return { catalog, values }
}

export async function listCatalog(name, { search = '', limit = 100, offset = 0 } = {}) {
  const { table } = getCatalog(name)
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200)
  const safeOffset = Math.max(Number(offset) || 0, 0)
  const searchColumn = name === 'productos' ? 'nombre' : 'razon_social'
  const { rows } = await pool.query(
    `SELECT * FROM ${table} WHERE activo = TRUE AND ($1 = '' OR ${searchColumn} ILIKE $2)
     ORDER BY id DESC LIMIT $3 OFFSET $4`,
    [search.trim(), `%${search.trim()}%`, safeLimit, safeOffset],
  )
  return rows
}

export async function getCatalogById(name, id) {
  const { table } = getCatalog(name)
  const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1 AND activo = TRUE`, [id])
  if (!rows[0]) throw httpError(404, 'Registro no encontrado.')
  return rows[0]
}

export async function createCatalog(name, input) {
  const { catalog, values } = normalizeInput(name, input)
  for (const field of catalog.required) {
    if (values[field] === undefined || values[field] === null || values[field] === '') {
      throw httpError(400, `El campo ${field} es obligatorio.`)
    }
  }
  // Si falta el precio de venta, propone un margen inicial del 40% sobre el costo.
  if (name === 'productos' && values.costo_unitario !== undefined && values.precio_venta === undefined) {
    values.precio_venta = new Decimal(String(values.costo_unitario)).mul('1.40').toDecimalPlaces(2).toFixed(2)
  }
  const fields = Object.keys(values)
  if (!fields.length) throw httpError(400, 'Debe enviar datos para crear el registro.')

  const parameters = fields.map((field) => values[field])
  const placeholders = fields.map((_, index) => `$${index + 1}`)
  const { rows } = await pool.query(
    `INSERT INTO ${catalog.table} (${fields.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    parameters,
  )
  return rows[0]
}

export async function updateCatalog(name, id, input) {
  const { catalog, values } = normalizeInput(name, input)
  const fields = Object.keys(values)
  if (!fields.length) throw httpError(400, 'Debe enviar al menos un campo para actualizar.')

  const assignments = fields.map((field, index) => `${field} = $${index + 1}`)
  const timestamp = name === 'productos' ? ', updated_at = NOW()' : ''
  const { rows } = await pool.query(
    `UPDATE ${catalog.table} SET ${assignments.join(', ')}${timestamp}
     WHERE id = $${fields.length + 1} AND activo = TRUE RETURNING *`,
    [...fields.map((field) => values[field]), id],
  )
  if (!rows[0]) throw httpError(404, 'Registro no encontrado.')
  return rows[0]
}

export async function deactivateCatalog(name, id) {
  // Conserva registros referenciados por operaciones anteriores mediante baja logica.
  const { table } = getCatalog(name)
  const timestamp = name === 'productos' ? ', updated_at = NOW()' : ''
  const { rows } = await pool.query(
    `UPDATE ${table} SET activo = FALSE${timestamp} WHERE id = $1 AND activo = TRUE RETURNING id`,
    [id],
  )
  if (!rows[0]) throw httpError(404, 'Registro no encontrado.')
}