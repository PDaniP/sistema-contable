-- Permite clientes monotributistas.
BEGIN;

ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_condicion_iva_check;
ALTER TABLE clientes ADD CONSTRAINT clientes_condicion_iva_check
    CHECK (condicion_iva IN ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTISTA', 'CONSUMIDOR_FINAL'));

COMMIT;
