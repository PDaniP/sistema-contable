import { createSettlement, listPending, listSettlements } from '../services/settlementService.js'

// El tipo (COBRO o PAGO) lo fija cada ruta; el servicio valida reglas y saldo dentro de una transaccion.
export const settlementHandlers = (type) => ({
  async list(request, response, next) {
    try {
      const [movimientos, pendientes] = await Promise.all([listSettlements(type), listPending(type)])
      response.json({ movimientos, pendientes })
    } catch (error) {
      next(error)
    }
  },
  async create(request, response, next) {
    try {
      response.status(201).json(await createSettlement(type, request.body, request.user.id))
    } catch (error) {
      next(error)
    }
  },
})
