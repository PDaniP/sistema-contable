import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

// Las plantillas PDF se generaron desde database/Archivos de Facturacion en Blanco.
const TEMPLATES = {
  FACTURA_A: fileURLToPath(new URL('../../assets/plantillas/Factura A.pdf', import.meta.url)),
  FACTURA_B: fileURLToPath(new URL('../../assets/plantillas/Factura B.pdf', import.meta.url)),
  FACTURA_C: fileURLToPath(new URL('../../assets/plantillas/Factura C.pdf', import.meta.url)),
}

// Factura C (emisor monotributista): no discrimina IVA y la plantilla trae 14 renglones con puntos a tapar.
const LAYOUT_C = {
  top: 630, step: 26.7, max: 14, baseline: 14,
  cols: { cant: [21.5, 35], desc: [59, 340], unit: [402, 87], importe: [492, 82] },
  ivaBoxes: { RESPONSABLE_INSCRIPTO: 126, MONOTRIBUTO: 210, EXENTO: 250, NO_RESPONSABLE: 298, CONSUMIDOR_FINAL: 356 },
}

// Coordenadas (puntos PDF, origen abajo-izquierda) de cada campo sobre la plantilla.
const LAYOUT = {
  FACTURA_C: {},
  FACTURA_A: {
    emisor: { x: 25, y: 800 }, numero: { x: 408, y: 796, cover: [405, 793, 100, 12] },
    fecha: { x: 428, y: 784, cover: [426, 781, 92, 11] },
    datosEmisor: { x: 372, ys: [774, 766, 758] },
    senores: { x: 74, y: 688.5 }, direccion: { x: 66, y: 679.5 }, localidad: { x: 330, y: 679.5 },
    cuit: { x: 254, y: 670.5 }, contado: { x: 150.5, y: 661 },
    items: { y: 621, step: 28.75, max: 12, cant: 58, desc: 100, unit: 447, importe: 568 },
    footer: { y: 220, cells: { subtotal: [20, 77], subtotal2: [184, 184], iva: [368, 112], total: [480, 95] } },
  },
  FACTURA_B: {
    emisor: { x: 25, y: 749 }, numero: { x: 408, y: 745, cover: [405, 742, 100, 12] },
    fecha: { x: 428, y: 733, cover: [426, 730, 92, 11] },
    datosEmisor: { x: 372, ys: [723, 715, 707] },
    senores: { x: 121, y: 636.5 }, direccion: { x: 123, y: 627.5 }, localidad: { x: 330, y: 627.5 },
    cuit: { x: 382, y: 617.5 }, contado: { x: 214.5, y: 608 },
    ivaBoxes: { CONSUMIDOR_FINAL: 160, MONOTRIBUTISTA: 226, EXENTO: 273, NO_RESPONSABLE: 325, y: 617 },
    items: { y: 576, step: 30.6, max: 12, cant: 39, desc: 62, unit: 478, importe: 568 },
    total: { x: 562, y: 171 },
  },
}

const company = () => ({
  razon: process.env.EMPRESA_RAZON_SOCIAL || 'Apex Software',
  cuit: process.env.EMPRESA_CUIT || '',
  domicilio: process.env.EMPRESA_DOMICILIO || '',
  localidad: process.env.EMPRESA_LOCALIDAD || '',
  iibb: process.env.EMPRESA_INGRESOS_BRUTOS || '',
  inicio: process.env.EMPRESA_INICIO_ACTIVIDADES || '',
})

const formatMoney = (value) => Number(value).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function formatDate(value) {
  const date = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getUTCDate())} / ${pad(date.getUTCMonth() + 1)} / ${date.getUTCFullYear()}`
}

function drawFacturaC({ page, text, cover, bold, operation, own, receiver }) {
  const L = LAYOUT_C
  text(own.razon, 25, 800, { size: 12, font: bold })
  text(own.domicilio, 25, 788, { size: 8 })
  text(own.localidad, 25, 779, { size: 8 })
  text(own.iibb ? `Ing. Brutos: ${own.iibb}` : '', 25, 770, { size: 8 })

  text(`N° ${operation.numero_comprobante}`, 478, 800, { size: 10, font: bold })
  cover([444, 780, 45, 11])
  text(formatDate(operation.fecha), 447, 783, { size: 8 })
  text(own.cuit, 352, 772, { size: 8 })
  cover([382, 762, 50, 9])
  text(own.inicio, 384, 764, { size: 8 })

  cover([53, 677, 420, 10])
  text(receiver.razon, 55, 680)
  cover([53, 667, 176, 10])
  text(receiver.domicilio, 55, 670)
  cover([255, 667, 90, 10])
  text(receiver.cuit, 408, 661, { size: 8 })
  const key = { CONSUMIDOR_FINAL: 'CONSUMIDOR_FINAL', MONOTRIBUTISTA: 'MONOTRIBUTO', EXENTO: 'EXENTO', RESPONSABLE_INSCRIPTO: 'RESPONSABLE_INSCRIPTO' }[receiver.condicion] ?? 'NO_RESPONSABLE'
  text('X', L.ivaBoxes[key], 661, { font: bold, size: 8 })
  text('X', 148, 652, { font: bold, size: 8 })

  // Cada renglón trae puntos de relleno en cada celda: se tapan todos, estén o no usados.
  for (let index = 0; index < L.max; index += 1) {
    const top = L.top - index * L.step
    Object.values(L.cols).forEach(([x, width]) => cover([x, top - L.step + 2, width, L.step - 4]))
    const line = operation.detalle[index]
    if (!line) continue
    const y = top - L.baseline
    text(line.cantidad, L.cols.cant[0] + L.cols.cant[1] / 2, y, { center: true })
    text(line.producto, L.cols.desc[0] + 2, y)
    text(formatMoney(Number(line.total) / Number(line.cantidad)), L.cols.unit[0] + L.cols.unit[1] - 4, y, { right: true })
    text(formatMoney(line.total), L.cols.importe[0] + L.cols.importe[1] - 4, y, { right: true })
  }
  text(formatMoney(operation.total), 570, 210, { right: true, font: bold })
}

// Completa la plantilla en blanco de Factura A o B con los datos de una venta o compra.
// En ventas la empresa es emisora; en compras emite el proveedor y la empresa es la receptora.
export async function renderInvoicePdf(operation, isSale) {
  const type = operation.tipo_comprobante
  const layout = LAYOUT[type]
  if (!layout) throw new Error(`Tipo de comprobante sin plantilla: ${type}`)

  const pdf = await PDFDocument.load(await readFile(TEMPLATES[type]))
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.getPage(0)
  const ink = rgb(0.05, 0.1, 0.45)
  const text = (value, x, y, { size = 9, right = false, center = false, font: face = font } = {}) => {
    const content = String(value ?? '')
    if (!content) return
    const width = face.widthOfTextAtSize(content, size)
    page.drawText(content, { x: right ? x - width : center ? x - width / 2 : x, y, size, font: face, color: ink })
  }
  const cover = ([x, y, width, height]) => page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1) })

  const own = company()
  const party = {
    razon: operation.contraparte,
    cuit: operation.contraparte_cuit,
    domicilio: operation.contraparte_domicilio,
    condicion: operation.contraparte_condicion_iva,
  }
  const issuer = isSale ? { ...own } : { razon: party.razon, cuit: party.cuit, domicilio: party.domicilio }
  const receiver = isSale ? party : {
    razon: own.razon, cuit: own.cuit, domicilio: own.domicilio, localidad: own.localidad, condicion: 'RESPONSABLE_INSCRIPTO',
  }

  if (type === 'FACTURA_C') {
    drawFacturaC({ page, text, cover, bold, layout, operation, own, receiver: party })
    return pdf.save()
  }

  text(issuer.razon, layout.emisor.x, layout.emisor.y, { size: 12, font: bold })
  // El domicilio del emisor se imprime bajo la razón social (en compras, el del proveedor).
  text(issuer.domicilio, layout.emisor.x, layout.emisor.y - 12, { size: 8 })
  text(issuer.localidad, layout.emisor.x, layout.emisor.y - 21, { size: 8 })
  cover(layout.numero.cover)
  text(`N° ${operation.numero_comprobante}`, layout.numero.x, layout.numero.y, { size: 10, font: bold })
  cover(layout.fecha.cover)
  text(formatDate(operation.fecha), layout.fecha.x, layout.fecha.y)
  const issuerData = [issuer.cuit, isSale ? own.iibb : '', isSale ? own.inicio : '']
  issuerData.forEach((value, index) => text(value, layout.datosEmisor.x, layout.datosEmisor.ys[index], { size: 8 }))

  text(receiver.razon, layout.senores.x, layout.senores.y)
  text(receiver.domicilio, layout.direccion.x, layout.direccion.y)
  text(receiver.localidad, layout.localidad.x, layout.direccion.y)
  text(receiver.cuit, layout.cuit.x, layout.cuit.y)

  if (type === 'FACTURA_B') {
    // La plantilla trae marcado Consumidor Final; se tapa y se marca la condición real.
    const boxes = layout.ivaBoxes
    cover([boxes.CONSUMIDOR_FINAL - 2, boxes.y - 2, 12, 11])
    page.drawRectangle({ x: boxes.CONSUMIDOR_FINAL, y: boxes.y, width: 4, height: 4, borderWidth: 0.5, borderColor: rgb(0, 0, 0) })
    const key = { CONSUMIDOR_FINAL: 'CONSUMIDOR_FINAL', MONOTRIBUTISTA: 'MONOTRIBUTISTA', EXENTO: 'EXENTO' }[receiver.condicion]
      ?? 'NO_RESPONSABLE'
    text('X', boxes[key] - 0.5, boxes.y, { font: bold, size: 8 })
  }
  text('X', layout.contado.x, layout.contado.y, { font: bold })

  const rows = layout.items
  const lines = operation.detalle.slice(0, rows.max)
  lines.forEach((line, index) => {
    const y = rows.y - index * rows.step
    // La Factura B no discrimina IVA: se muestran precios finales.
    const importe = type === 'FACTURA_A' ? Number(line.neto) : Number(line.total)
    const unit = importe / Number(line.cantidad)
    text(line.cantidad, rows.cant, y, { center: true })
    text(line.producto, rows.desc, y)
    text(formatMoney(unit), rows.unit, y, { right: true })
    text(formatMoney(importe), rows.importe, y, { right: true })
  })

  if (type === 'FACTURA_A') {
    const footer = layout.footer
    // Los rótulos de la plantilla ocupan toda la celda: se redibujan junto al importe.
    const cell = (key, label, value) => {
      const [x, width] = footer.cells[key]
      cover([x + 1, footer.y - 4, width - 2, 17])
      text(label, x + 3, footer.y, { size: 7, font: bold })
      text(formatMoney(value), x + width - 3, footer.y, { size: 7, right: true })
    }
    cell('subtotal', 'SUBTOTAL', operation.neto)
    cell('subtotal2', 'SUBTOTAL', operation.neto)
    cell('iva', 'IVA Insc. 21 %', operation.iva)
    cell('total', 'TOTAL $', operation.total)
  } else {
    text(formatMoney(operation.total), layout.total.x, layout.total.y, { right: true, font: bold })
  }
  return pdf.save()
}
