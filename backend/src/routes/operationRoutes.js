import { Router } from 'express'
import { addPurchase, addSale, invoicePdf, listOperations } from '../controllers/operationController.js'
import { accounts, dashboard, journal, ledger, paymentMethods, settleVat, vatSummary } from '../controllers/reportController.js'
import { requireAuth } from '../middleware/auth.js'
import { settlementHandlers } from '../controllers/settlementController.js'

const cobros = settlementHandlers('COBRO')
const pagos = settlementHandlers('PAGO')

const router = Router()

// Protege todas las consultas y escrituras de negocio de este router.
router.use(requireAuth)
router.get('/dashboard', dashboard)
router.get('/cuentas', accounts)
router.get('/formas-pago', paymentMethods)
router.post('/ventas', addSale)
// Fija el tipo antes de reutilizar el controlador generico de lista y detalle.
router.get('/ventas', (request, response, next) => {
  request.params.type = 'ventas'
  return listOperations(request, response, next)
})
router.get('/ventas/:id', (request, response, next) => {
  request.params.type = 'ventas'
  return listOperations(request, response, next)
})
router.get('/ventas/:id/pdf', (request, response, next) => {
  request.params.type = 'ventas'
  return invoicePdf(request, response, next)
})
router.get('/compras/:id/pdf', (request, response, next) => {
  request.params.type = 'compras'
  return invoicePdf(request, response, next)
})
router.post('/compras', addPurchase)
router.get('/compras', (request, response, next) => {
  request.params.type = 'compras'
  return listOperations(request, response, next)
})
router.get('/compras/:id', (request, response, next) => {
  request.params.type = 'compras'
  return listOperations(request, response, next)
})
router.get('/libro-diario', journal)
router.get('/cobros', cobros.list)
router.post('/cobros', cobros.create)
router.get('/pagos', pagos.list)
router.post('/pagos', pagos.create)
router.get('/asientos', journal)
router.get('/asientos/:id', journal)
router.get('/mayor/:cuentaId', ledger)
router.get('/iva', vatSummary)
router.post('/iva/liquidar', settleVat)

export default router