-- Permite renglones de compra sin producto de catálogo (solo descripción y precio).
BEGIN;

ALTER TABLE detalle_compras ALTER COLUMN producto_id DROP NOT NULL;
ALTER TABLE detalle_compras ADD COLUMN IF NOT EXISTS descripcion VARCHAR(180);
ALTER TABLE detalle_compras DROP CONSTRAINT IF EXISTS detalle_compras_producto_o_descripcion;
ALTER TABLE detalle_compras ADD CONSTRAINT detalle_compras_producto_o_descripcion
    CHECK (producto_id IS NOT NULL OR descripcion IS NOT NULL);

INSERT INTO cuentas_contables (codigo, nombre, tipo)
VALUES ('5.2.01', 'Gastos y Servicios Varios', 'RESULTADO_NEGATIVO')
ON CONFLICT (codigo) DO NOTHING;

COMMIT;
