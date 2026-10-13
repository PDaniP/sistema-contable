-- Cobros (recibos) y pagos (órdenes de pago): cancelan saldos pendientes de ventas y compras
-- realizados en cuenta corriente, pagaré o cheque diferido.
BEGIN;

CREATE SEQUENCE IF NOT EXISTS numero_recibo_seq START WITH 1;
CREATE SEQUENCE IF NOT EXISTS numero_orden_pago_seq START WITH 1;

CREATE TABLE IF NOT EXISTS cancelaciones (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tipo VARCHAR(5) NOT NULL CHECK (tipo IN ('COBRO', 'PAGO')),
    numero VARCHAR(30) NOT NULL UNIQUE,
    pago_operacion_id BIGINT NOT NULL REFERENCES pagos_operacion(id),
    forma_pago_id BIGINT NOT NULL REFERENCES formas_pago(id),
    fecha DATE NOT NULL,
    importe NUMERIC(14, 2) NOT NULL CHECK (importe > 0),
    observaciones VARCHAR(240),
    creado_por BIGINT NOT NULL REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cancelaciones_pago ON cancelaciones (pago_operacion_id);

ALTER TABLE asientos ADD COLUMN IF NOT EXISTS cancelacion_id BIGINT REFERENCES cancelaciones(id);

-- Reemplaza los CHECK de asientos que dependen del origen o del tipo, sin depender de sus nombres.
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'asientos'::regclass AND contype = 'c'
               AND (pg_get_constraintdef(oid) LIKE '%tipo_operacion%'
                    OR pg_get_constraintdef(oid) LIKE '%liquidacion_iva_id%') LOOP
        EXECUTE format('ALTER TABLE asientos DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

ALTER TABLE asientos ADD CONSTRAINT asientos_tipo_operacion_check
    CHECK (tipo_operacion IN ('VENTA', 'CMV', 'COMPRA', 'LIQUIDACION_IVA', 'APERTURA', 'COBRO', 'PAGO'));
ALTER TABLE asientos ADD CONSTRAINT asientos_un_origen_check CHECK (
    (venta_id IS NOT NULL)::INTEGER + (compra_id IS NOT NULL)::INTEGER
    + (liquidacion_iva_id IS NOT NULL)::INTEGER + (cancelacion_id IS NOT NULL)::INTEGER <= 1
);
ALTER TABLE asientos ADD CONSTRAINT asientos_origen_check CHECK (
    (tipo_operacion IN ('VENTA', 'CMV') AND venta_id IS NOT NULL)
    OR (tipo_operacion = 'COMPRA' AND compra_id IS NOT NULL)
    OR (tipo_operacion = 'LIQUIDACION_IVA' AND liquidacion_iva_id IS NOT NULL)
    OR (tipo_operacion IN ('COBRO', 'PAGO') AND cancelacion_id IS NOT NULL)
    OR (tipo_operacion = 'APERTURA' AND venta_id IS NULL AND compra_id IS NULL
        AND liquidacion_iva_id IS NULL AND cancelacion_id IS NULL)
);

COMMIT;
