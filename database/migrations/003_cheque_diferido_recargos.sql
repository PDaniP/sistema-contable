-- Cheque diferido y recargo porcentual por forma de pago.
BEGIN;

ALTER TABLE pagos_operacion
    ADD COLUMN IF NOT EXISTS recargo_porcentaje NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (recargo_porcentaje >= 0),
    ADD COLUMN IF NOT EXISTS recargo_importe NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (recargo_importe >= 0);

INSERT INTO cuentas_contables (codigo, nombre, tipo) VALUES
    ('4.2.01', 'Recargos Financieros Ganados', 'RESULTADO_POSITIVO'),
    ('5.2.02', 'Recargos Financieros Pagados', 'RESULTADO_NEGATIVO')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO formas_pago (codigo, nombre, cuenta_venta_id, cuenta_compra_id)
SELECT 'CHEQUE_DIFERIDO', 'Cheque diferido', venta.id, compra.id
FROM cuentas_contables venta, cuentas_contables compra
WHERE venta.codigo = '1.1.04' AND compra.codigo = '2.1.02'
ON CONFLICT (codigo) DO NOTHING;

COMMIT;
