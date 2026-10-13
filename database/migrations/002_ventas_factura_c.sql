-- Habilita Factura C (emisor monotributista) en ventas.
BEGIN;

ALTER TABLE ventas DROP CONSTRAINT IF EXISTS ventas_tipo_comprobante_check;
ALTER TABLE ventas ADD CONSTRAINT ventas_tipo_comprobante_check
    CHECK (tipo_comprobante IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C'));

COMMIT;
