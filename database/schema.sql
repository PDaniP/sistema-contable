BEGIN;

-- Usuarios y contrapartes: las restricciones limitan identificadores y condiciones fiscales validas.
CREATE TABLE usuarios (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rol VARCHAR(20) NOT NULL DEFAULT 'ADMIN' CHECK (rol IN ('ADMIN')),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE clientes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    razon_social VARCHAR(180) NOT NULL,
    identificacion VARCHAR(20) UNIQUE,
    domicilio VARCHAR(240),
    condicion_iva VARCHAR(30) NOT NULL CHECK (
        condicion_iva IN ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTISTA', 'CONSUMIDOR_FINAL')
    ),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE proveedores (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    razon_social VARCHAR(180) NOT NULL,
    cuit VARCHAR(20) NOT NULL UNIQUE,
    domicilio VARCHAR(240),
    condicion_iva VARCHAR(30) NOT NULL DEFAULT 'RESPONSABLE_INSCRIPTO' CHECK (
        condicion_iva IN (
            'RESPONSABLE_INSCRIPTO', 'CONSUMIDOR_FINAL', 'MONOTRIBUTISTA', 'EXENTO'
        )
    ),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE productos (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre VARCHAR(160) NOT NULL,
    descripcion TEXT,
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    costo_unitario NUMERIC(14, 2) NOT NULL CHECK (costo_unitario >= 0),
    precio_venta NUMERIC(14, 2) NOT NULL CHECK (precio_venta >= 0),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE cuentas_contables (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo VARCHAR(20) NOT NULL UNIQUE,
    nombre VARCHAR(120) NOT NULL UNIQUE,
    tipo VARCHAR(30) NOT NULL CHECK (
        tipo IN ('ACTIVO', 'PASIVO', 'PATRIMONIO_NETO', 'RESULTADO_POSITIVO', 'RESULTADO_NEGATIVO')
    ),
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE formas_pago (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo VARCHAR(30) NOT NULL UNIQUE,
    nombre VARCHAR(80) NOT NULL UNIQUE,
    cuenta_venta_id BIGINT REFERENCES cuentas_contables(id),
    cuenta_compra_id BIGINT REFERENCES cuentas_contables(id),
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

-- Operaciones comerciales: cabeceras con totales, detalles con valores por renglon y comprobantes unicos.
CREATE SEQUENCE numero_comprobante_seq START WITH 1;

CREATE TABLE ventas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cliente_id BIGINT NOT NULL REFERENCES clientes(id),
    fecha DATE NOT NULL,
    tipo_comprobante VARCHAR(10) NOT NULL CHECK (tipo_comprobante IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C')),
    numero_comprobante VARCHAR(30) NOT NULL DEFAULT (
        '0001-' || LPAD(nextval('numero_comprobante_seq')::TEXT, 8, '0')
    ),
    neto NUMERIC(14, 2) NOT NULL CHECK (neto >= 0),
    iva NUMERIC(14, 2) NOT NULL CHECK (iva >= 0),
    total NUMERIC(14, 2) NOT NULL CHECK (total >= 0),
    creado_por BIGINT NOT NULL REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tipo_comprobante, numero_comprobante),
    CHECK (total = neto + iva)
);

CREATE TABLE detalle_ventas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venta_id BIGINT NOT NULL REFERENCES ventas(id),
    producto_id BIGINT NOT NULL REFERENCES productos(id),
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    precio_unitario NUMERIC(14, 2) NOT NULL CHECK (precio_unitario >= 0),
    costo_unitario_snapshot NUMERIC(14, 2) NOT NULL CHECK (costo_unitario_snapshot >= 0),
    neto NUMERIC(14, 2) NOT NULL CHECK (neto >= 0),
    iva NUMERIC(14, 2) NOT NULL CHECK (iva >= 0),
    total NUMERIC(14, 2) NOT NULL CHECK (total >= 0),
    CHECK (total = neto + iva)
);

CREATE TABLE compras (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proveedor_id BIGINT NOT NULL REFERENCES proveedores(id),
    fecha DATE NOT NULL,
    tipo_comprobante VARCHAR(20) NOT NULL DEFAULT 'FACTURA_A',
    numero_comprobante VARCHAR(30) NOT NULL,
    neto NUMERIC(14, 2) NOT NULL CHECK (neto >= 0),
    iva NUMERIC(14, 2) NOT NULL CHECK (iva >= 0),
    total NUMERIC(14, 2) NOT NULL CHECK (total >= 0),
    creado_por BIGINT NOT NULL REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (proveedor_id, tipo_comprobante, numero_comprobante),
    CHECK (total = neto + iva)
);

CREATE TABLE detalle_compras (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    compra_id BIGINT NOT NULL REFERENCES compras(id),
    producto_id BIGINT REFERENCES productos(id),
    descripcion VARCHAR(180),
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    precio_unitario NUMERIC(14, 2) NOT NULL CHECK (precio_unitario >= 0),
    neto NUMERIC(14, 2) NOT NULL CHECK (neto >= 0),
    iva NUMERIC(14, 2) NOT NULL CHECK (iva >= 0),
    total NUMERIC(14, 2) NOT NULL CHECK (total >= 0),
    CHECK (total = neto + iva),
    CHECK (producto_id IS NOT NULL OR descripcion IS NOT NULL)
);

CREATE TABLE pagos_operacion (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venta_id BIGINT REFERENCES ventas(id),
    compra_id BIGINT REFERENCES compras(id),
    forma_pago_id BIGINT NOT NULL REFERENCES formas_pago(id),
    importe NUMERIC(14, 2) NOT NULL CHECK (importe > 0),
    recargo_porcentaje NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (recargo_porcentaje >= 0),
    recargo_importe NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (recargo_importe >= 0),
    CHECK ((venta_id IS NOT NULL)::INTEGER + (compra_id IS NOT NULL)::INTEGER = 1)
);

-- Cobros (recibos) y pagos (ordenes de pago) que cancelan saldos pendientes de operaciones a credito.
CREATE SEQUENCE numero_recibo_seq START WITH 1;
CREATE SEQUENCE numero_orden_pago_seq START WITH 1;

CREATE TABLE cancelaciones (
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
CREATE INDEX idx_cancelaciones_pago ON cancelaciones (pago_operacion_id);

-- El saldo de stock se acompana de un historial que valida cantidad y referencia de compra/venta.
CREATE TABLE movimientos_stock (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producto_id BIGINT NOT NULL REFERENCES productos(id),
    fecha DATE NOT NULL,
    tipo_movimiento VARCHAR(10) NOT NULL CHECK (tipo_movimiento IN ('COMPRA', 'VENTA', 'AJUSTE')),
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    stock_anterior INTEGER NOT NULL CHECK (stock_anterior >= 0),
    stock_nuevo INTEGER NOT NULL CHECK (stock_nuevo >= 0),
    venta_id BIGINT REFERENCES ventas(id),
    compra_id BIGINT REFERENCES compras(id),
    CHECK (
        (tipo_movimiento = 'VENTA' AND venta_id IS NOT NULL AND compra_id IS NULL
            AND stock_anterior - cantidad = stock_nuevo)
        OR (tipo_movimiento = 'COMPRA' AND compra_id IS NOT NULL AND venta_id IS NULL
            AND stock_anterior + cantidad = stock_nuevo)
        OR (tipo_movimiento = 'AJUSTE' AND venta_id IS NULL AND compra_id IS NULL)
    )
);

CREATE TABLE liquidaciones_iva (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mes SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
    anio SMALLINT NOT NULL CHECK (anio BETWEEN 2000 AND 9999),
    iva_debito NUMERIC(14, 2) NOT NULL CHECK (iva_debito >= 0),
    iva_credito NUMERIC(14, 2) NOT NULL CHECK (iva_credito >= 0),
    saldo NUMERIC(14, 2) NOT NULL,
    resultado VARCHAR(20) NOT NULL CHECK (
        resultado IN ('A_PAGAR', 'SALDO_A_FAVOR', 'SIN_SALDO')
    ),
    creado_por BIGINT NOT NULL REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (mes, anio),
    CHECK (saldo = iva_debito - iva_credito),
    CHECK (
        (saldo > 0 AND resultado = 'A_PAGAR')
        OR (saldo < 0 AND resultado = 'SALDO_A_FAVOR')
        OR (saldo = 0 AND resultado = 'SIN_SALDO')
    )
);

-- Asientos y renglones del diario: cada operacion referencia su origen y cada linea una cuenta.
CREATE TABLE asientos (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fecha DATE NOT NULL,
    descripcion VARCHAR(240) NOT NULL,
    tipo_operacion VARCHAR(20) NOT NULL CHECK (
        tipo_operacion IN ('VENTA', 'CMV', 'COMPRA', 'LIQUIDACION_IVA', 'APERTURA', 'COBRO', 'PAGO')
    ),
    venta_id BIGINT REFERENCES ventas(id),
    compra_id BIGINT REFERENCES compras(id),
    liquidacion_iva_id BIGINT REFERENCES liquidaciones_iva(id),
    cancelacion_id BIGINT REFERENCES cancelaciones(id),
    creado_por BIGINT NOT NULL REFERENCES usuarios(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (venta_id IS NOT NULL)::INTEGER
        + (compra_id IS NOT NULL)::INTEGER
        + (liquidacion_iva_id IS NOT NULL)::INTEGER
        + (cancelacion_id IS NOT NULL)::INTEGER <= 1
    ),
    CHECK (
        (tipo_operacion IN ('VENTA', 'CMV') AND venta_id IS NOT NULL)
        OR (tipo_operacion = 'COMPRA' AND compra_id IS NOT NULL)
        OR (tipo_operacion = 'LIQUIDACION_IVA' AND liquidacion_iva_id IS NOT NULL)
        OR (tipo_operacion IN ('COBRO', 'PAGO') AND cancelacion_id IS NOT NULL)
        OR (tipo_operacion = 'APERTURA' AND venta_id IS NULL AND compra_id IS NULL
            AND liquidacion_iva_id IS NULL AND cancelacion_id IS NULL)
    )
);

CREATE TABLE detalle_asientos (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asiento_id BIGINT NOT NULL REFERENCES asientos(id) ON DELETE RESTRICT,
    cuenta_id BIGINT NOT NULL REFERENCES cuentas_contables(id),
    debe NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (debe >= 0),
    haber NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (haber >= 0),
    CHECK ((debe > 0 AND haber = 0) OR (haber > 0 AND debe = 0))
);

CREATE UNIQUE INDEX uq_asiento_por_liquidacion
    ON asientos (liquidacion_iva_id)
    WHERE liquidacion_iva_id IS NOT NULL;

CREATE INDEX idx_ventas_fecha ON ventas (fecha);
CREATE INDEX idx_compras_fecha ON compras (fecha);
CREATE INDEX idx_asientos_fecha_tipo ON asientos (fecha, tipo_operacion);
CREATE INDEX idx_detalle_asientos_cuenta ON detalle_asientos (cuenta_id, asiento_id);
CREATE INDEX idx_movimientos_stock_producto_fecha ON movimientos_stock (producto_id, fecha);

-- Plan contable y medios de pago iniciales; los codigos conectan cada medio con sus cuentas.
INSERT INTO cuentas_contables (codigo, nombre, tipo) VALUES
    ('1.1.01', 'Caja', 'ACTIVO'),
    ('1.1.02', 'Banco Cuenta Corriente', 'ACTIVO'),
    ('1.1.03', 'Mercaderias', 'ACTIVO'),
    ('1.1.04', 'Documentos a Cobrar', 'ACTIVO'),
    ('1.1.05', 'IVA Credito Fiscal', 'ACTIVO'),
    ('1.1.06', 'Deudores por ventas', 'ACTIVO'),
    ('1.1.07', 'IVA Saldo a Favor', 'ACTIVO'),
    ('2.1.01', 'Proveedores', 'PASIVO'),
    ('2.1.02', 'Documentos a Pagar', 'PASIVO'),
    ('2.1.03', 'IVA a Pagar', 'PASIVO'),
    ('2.1.04', 'IVA Debito Fiscal', 'PASIVO'),
    ('3.1.01', 'Capital', 'PATRIMONIO_NETO'),
    ('4.1.01', 'Ventas', 'RESULTADO_POSITIVO'),
    ('5.1.01', 'Costo de Mercaderias Vendidas', 'RESULTADO_NEGATIVO'),
    ('5.2.01', 'Gastos y Servicios Varios', 'RESULTADO_NEGATIVO'),
    ('4.2.01', 'Recargos Financieros Ganados', 'RESULTADO_POSITIVO'),
    ('5.2.02', 'Recargos Financieros Pagados', 'RESULTADO_NEGATIVO')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO formas_pago (codigo, nombre, cuenta_venta_id, cuenta_compra_id)
SELECT medios.codigo, medios.nombre, venta.id, compra.id
FROM (VALUES
    ('EFECTIVO', 'Efectivo', '1.1.01', '1.1.01'),
    ('BANCO', 'Banco', '1.1.02', '1.1.02'),
    ('CHEQUE_PROPIO', 'Cheque propio', '1.1.02', '1.1.02'),
    ('CHEQUE_DIFERIDO', 'Cheque diferido', '1.1.04', '2.1.02'),
    ('CUENTA_CORRIENTE', 'Cuenta corriente', '1.1.06', '2.1.01'),
    ('PAGARE', 'Pagaré / documento', '1.1.04', '2.1.02')
) AS medios(codigo, nombre, codigo_venta, codigo_compra)
JOIN cuentas_contables AS venta ON venta.codigo = medios.codigo_venta
JOIN cuentas_contables AS compra ON compra.codigo = medios.codigo_compra
ON CONFLICT (codigo) DO NOTHING;

COMMIT;