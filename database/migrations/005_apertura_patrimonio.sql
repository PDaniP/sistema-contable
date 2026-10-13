-- Asiento de apertura: patrimonio neto inicial de $8.500.000 (Banco 8.000.000 + Caja 500.000).
BEGIN;

ALTER TABLE cuentas_contables DROP CONSTRAINT IF EXISTS cuentas_contables_tipo_check;
ALTER TABLE cuentas_contables ADD CONSTRAINT cuentas_contables_tipo_check
    CHECK (tipo IN ('ACTIVO', 'PASIVO', 'PATRIMONIO_NETO', 'RESULTADO_POSITIVO', 'RESULTADO_NEGATIVO'));

-- Reemplaza los CHECK de asientos que enumeran tipo_operacion, sin depender de sus nombres.
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'asientos'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%tipo_operacion%' LOOP
        EXECUTE format('ALTER TABLE asientos DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

ALTER TABLE asientos ADD CONSTRAINT asientos_tipo_operacion_check
    CHECK (tipo_operacion IN ('VENTA', 'CMV', 'COMPRA', 'LIQUIDACION_IVA', 'APERTURA'));
ALTER TABLE asientos ADD CONSTRAINT asientos_origen_check CHECK (
    (tipo_operacion IN ('VENTA', 'CMV') AND venta_id IS NOT NULL
        AND compra_id IS NULL AND liquidacion_iva_id IS NULL)
    OR (tipo_operacion = 'COMPRA' AND compra_id IS NOT NULL
        AND venta_id IS NULL AND liquidacion_iva_id IS NULL)
    OR (tipo_operacion = 'LIQUIDACION_IVA' AND liquidacion_iva_id IS NOT NULL
        AND venta_id IS NULL AND compra_id IS NULL)
    OR (tipo_operacion = 'APERTURA' AND venta_id IS NULL
        AND compra_id IS NULL AND liquidacion_iva_id IS NULL)
);

INSERT INTO cuentas_contables (codigo, nombre, tipo) VALUES ('3.1.01', 'Capital', 'PATRIMONIO_NETO')
ON CONFLICT (codigo) DO NOTHING;

DO $$
DECLARE asiento BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM asientos WHERE tipo_operacion = 'APERTURA') THEN
        INSERT INTO asientos (fecha, descripcion, tipo_operacion, creado_por)
        VALUES (CURRENT_DATE, 'Asiento de apertura - patrimonio neto inicial', 'APERTURA',
                (SELECT id FROM usuarios ORDER BY id LIMIT 1))
        RETURNING id INTO asiento;

        INSERT INTO detalle_asientos (asiento_id, cuenta_id, debe, haber)
        SELECT asiento, id, 8000000, 0 FROM cuentas_contables WHERE codigo = '1.1.02';
        INSERT INTO detalle_asientos (asiento_id, cuenta_id, debe, haber)
        SELECT asiento, id, 500000, 0 FROM cuentas_contables WHERE codigo = '1.1.01';
        INSERT INTO detalle_asientos (asiento_id, cuenta_id, debe, haber)
        SELECT asiento, id, 0, 8500000 FROM cuentas_contables WHERE codigo = '3.1.01';
    END IF;
END $$;

COMMIT;
