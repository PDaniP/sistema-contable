import { useEffect, useState } from 'react'
import {
  ArrowDownLeft, ArrowUpRight, BookOpen, Boxes, BriefcaseBusiness, CalendarDays,
  Check, ClipboardList, CreditCard, FileText, Home, LogOut, Menu, Pencil,
  Plus, Settings, ShieldCheck, ShoppingBag, ShoppingCart, Users, X,
} from 'lucide-react'
import api, { errorMessage } from './api'
import './theme.css'

// Secciones visibles de la aplicacion; el id tambien determina que endpoint consulta el panel.
const sections = [
  { id: 'dashboard', label: 'Resumen', icon: Home },
  { id: 'ventas', label: 'Ventas', icon: ShoppingCart },
  { id: 'compras', label: 'Compras', icon: ShoppingBag },
  { id: 'productos', label: 'Productos', icon: Boxes },
  { id: 'clientes', label: 'Clientes', icon: Users },
  { id: 'proveedores', label: 'Proveedores', icon: BriefcaseBusiness },
  { id: 'diario', label: 'Libro Diario', icon: BookOpen },
  { id: 'mayor', label: 'Mayor', icon: ClipboardList },
  { id: 'iva', label: 'Liquidación IVA', icon: FileText },
]

const currency = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })
const localNow = new Date()
const today = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`
const currentMonth = new Date().getMonth() + 1
const currentYear = new Date().getFullYear()
const currentDateLabel = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date())
const currentPeriodLabel = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric' }).format(new Date())
const money = (value) => currency.format(Number(value || 0))
const dateLabel = (value) => value ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('es-AR') : '—'

// Coordina sesion, datos compartidos, navegacion y formularios de las distintas pantallas.
function App() {
  const [user, setUser] = useState(null)
  const [section, setSection] = useState('dashboard')
  const [data, setData] = useState([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [modal, setModal] = useState(false)
  const [invoice, setInvoice] = useState(null)
  const [partyModalType, setPartyModalType] = useState(null)
  const [createdParty, setCreatedParty] = useState(null)
  const [editingRecord, setEditingRecord] = useState(null)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [filters, setFilters] = useState({ mes: currentMonth, anio: currentYear, desde: '', hasta: '', tipo: '' })
  const [lookups, setLookups] = useState({ clientes: [], proveedores: [], productos: [], formas: [], cuentas: [] })

  // Al iniciar, intenta recuperar la sesion persistida en la cookie httpOnly.
  useEffect(() => {
    api.get('/auth/me').then(({ data: response }) => setUser(response.user)).catch(() => {})
  }, [])

  // Los catalogos se cargan una vez autenticado el usuario para alimentar formularios y filtros.
  useEffect(() => {
    if (!user) return
    Promise.all([
      api.get('/clientes'), api.get('/proveedores'), api.get('/productos'),
      api.get('/formas-pago'), api.get('/cuentas'),
    ]).then(([customers, providers, products, methods, accounts]) => setLookups({
      clientes: customers.data, proveedores: providers.data, productos: products.data,
      formas: methods.data, cuentas: accounts.data,
    })).catch(() => {})
  }, [user])

  // Cada seccion obtiene sus datos del endpoint correspondiente; filtros y cuenta seleccionada disparan recarga.
  useEffect(() => {
    if (!user) return
    const load = async () => {
      let result
      if (section === 'dashboard') result = (await api.get('/dashboard')).data
      else if (section === 'ventas' || section === 'compras') result = (await api.get(`/${section}`)).data
      else if (['productos', 'clientes', 'proveedores'].includes(section)) result = (await api.get(`/${section}`)).data
      else if (section === 'diario') {
        const params = Object.fromEntries(Object.entries(filters).filter(([key, value]) => ['desde', 'hasta', 'tipo'].includes(key) && value))
        result = (await api.get('/libro-diario', { params })).data
      } else if (section === 'mayor') {
        const accountId = filters.cuentaId || lookups.cuentas[0]?.id
        result = accountId ? (await api.get(`/mayor/${accountId}`)).data : { cuenta: null, movimientos: [] }
      } else if (section === 'iva') result = (await api.get('/iva', { params: { mes: filters.mes, anio: filters.anio } })).data
      setData(result || [])
    }
    load().catch((error) => setNotice(errorMessage(error))).finally(() => setBusy(false))
  }, [section, user, filters, lookups.cuentas])

  // Envia las credenciales y conserva en estado el usuario devuelto por el servidor.
  async function signIn(event) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    const form = new FormData(event.currentTarget)
    try {
      const { data: response } = await api.post('/auth/login', {
        email: form.get('email'), password: form.get('password'),
      })
      setUser(response.user)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  // Cierra la cookie del servidor y restablece la pantalla al estado de acceso.
  async function signOut() {
    await api.post('/auth/logout').catch(() => {})
    setUser(null)
    setSection('dashboard')
  }

  // Cambia de modulo y limpia datos/edicion temporal para no mezclar formularios entre pantallas.
  function navigate(id) {
    setData(id === 'dashboard' || id === 'iva' ? {} : id === 'mayor' ? { movimientos: [] } : [])
    setSection(id)
    setMobileMenu(false)
    setModal(false)
    setPartyModalType(null)
    setCreatedParty(null)
    setEditingRecord(null)
  }

  // Carga el detalle completo y abre la factura lista para imprimir o guardar como PDF.
  async function viewInvoice(id) {
    try {
      const { data: detail } = await api.get(`/${section}/${id}`)
      setInvoice({ ...detail, esVenta: section === 'ventas' })
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  // Publica una venta o compra; el API valida y registra la operacion dentro de una transaccion.
  async function submitOperation(payload) {
    const path = section === 'ventas' ? '/ventas' : '/compras'
    const { data: response } = await api.post(path, payload)
    setModal(false)
    setNotice(`${section === 'ventas' ? 'Venta' : 'Compra'} registrada. Comprobante ${response.numero_comprobante}.`)
    setSection('dashboard')
  }

  // Crea o actualiza un registro y sincroniza tanto la lista actual como los catalogos compartidos.
  async function submitCatalog(payload, id) {
    const { data: saved } = id
      ? await api.put(`/${section}/${id}`, payload)
      : await api.post(`/${section}`, payload)
    const { data: updated } = await api.get(`/${section}`)
    setData(updated)
    const key = section === 'productos' ? 'productos' : section
    setLookups((previous) => ({
      ...previous,
      [key]: id ? previous[key].map((record) => record.id === id ? saved : record) : [...previous[key], saved],
    }))
    setModal(false)
    setEditingRecord(null)
    setNotice(id ? 'Registro actualizado correctamente.' : 'Registro creado correctamente.')
  }

  // Permite crear cliente/proveedor desde el formulario de operacion sin perder su contexto.
  async function submitInlineParty(type, payload) {
    const { data: saved } = await api.post(`/${type}`, payload)
    setLookups((previous) => ({ ...previous, [type]: [...previous[type], saved] }))
    setCreatedParty(saved)
    setPartyModalType(null)
    setNotice(`${type === 'clientes' ? 'Cliente' : 'Proveedor'} creado correctamente.`)
    return saved
  }

  // Retira de las listas el registro dado de baja por el API sin borrar su historial contable.
  async function deactivate(id) {
    try {
      await api.delete(`/${section}/${id}`)
      setData((previous) => previous.filter((record) => record.id !== id))
      const key = section === 'productos' ? 'productos' : section
      setLookups((previous) => ({ ...previous, [key]: previous[key].filter((record) => record.id !== id) }))
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  // Liquida el mes seleccionado y vuelve a consultar su estado para reflejar el cierre.
  async function settleVat() {
    setBusy(true)
    try {
      await api.post('/iva/liquidar', { mes: Number(filters.mes), anio: Number(filters.anio) })
      const { data: updated } = await api.get('/iva', { params: { mes: filters.mes, anio: filters.anio } })
      setData(updated)
      setNotice('Liquidación y asiento de cierre registrados.')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  // Sin sesion se muestra solo el acceso; autenticado se habilita la navegacion y las vistas.
  if (!user) {
    return (
      <main className="login-screen">
        <section className="login-brand">
          <img className="apex-logo-login" src="/Logo%20Apex%20Software.png" alt="Apex Software" />
          <div className="brand-caption">ESTUDIO CONTABLE · 01</div>
          <h1>Las cuentas<br />en su lugar.</h1>
          <p>APEX SOFTWARE <span>·</span> Desarrollo de paginas web</p>
          <div className="login-ledger"><span>DEBE</span><span>HABER</span><b>$ 1.985.000</b><b>$ 1.985.000</b></div>
        </section>
        <form className="login-form" onSubmit={signIn}>
          <div className="eyebrow">ACCESO AL SISTEMA</div>
          <h2>Bienvenido</h2>
          <p>Ingresá con tu cuenta de administrador.</p>
          {notice && <div className="notice error">{notice}</div>}
          <label>Email<input type="email" name="email" autoComplete="username" required /></label>
          <label>Contraseña<input type="password" name="password" autoComplete="current-password" required /></label>
          <button className="button primary full" disabled={busy}>{busy ? 'Ingresando…' : 'Ingresar'}<ArrowUpRight size={17} /></button>
          <div className="login-foot"><ShieldCheck size={15} /> Sesión protegida con autenticación segura</div>
        </form>
      </main>
    )
  }

  const pageTitle = sections.find((item) => item.id === section)?.label || 'Configuración'
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? 'open' : ''}`}>
        <div className="brand-lockup" onClick={() => navigate('dashboard')} role="button" tabIndex={0}>
          <img className="apex-logo-sidebar" src="/Logo%20Apex%20Software.png" alt="Apex Software" />
        </div>
        <div className="side-caption">GESTIÓN</div>
        <nav aria-label="Navegación principal">
          {sections.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${section === id ? 'active' : ''}`} onClick={() => navigate(id)}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
              {id === 'iva' && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="company-chip"><span className="online-dot" /><span><b>Período actual</b><small>{currentPeriodLabel}</small></span></div>
          <button className={`nav-item ${section === 'configuracion' ? 'active' : ''}`} onClick={() => navigate('configuracion')}><Settings size={18} /><span>Configuración</span></button>
          <button className="profile-row" onClick={signOut} title="Cerrar sesión">
            <span className="avatar">{user.nombre?.slice(0, 1) || 'A'}</span>
            <span><b>{user.nombre}</b><small>Administrador</small></span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Abrir menú" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={20} /></button>
          <div className="breadcrumb"><span>APEX SOFTWARE</span><span className="crumb-sep">/</span><b>{pageTitle}</b></div>
          <div className="topbar-right"><span className="today"><CalendarDays size={15} />{currentDateLabel}</span><span className="top-avatar">{user.nombre?.slice(0, 1) || 'A'}</span></div>
        </header>

        <div className="page-wrap">
          {notice && <div className={`notice ${notice.includes('registrad') || notice.includes('correctamente') ? 'success' : ''}`} role="status">{notice}<button aria-label="Cerrar aviso" onClick={() => setNotice('')}><X size={16} /></button></div>}
          {busy && <div className="loading-line" />}
          {section === 'dashboard' && <Dashboard data={data} navigate={navigate} />}
          {section === 'ventas' && <OperationList type="ventas" rows={data} onCreate={() => setModal(true)} onView={viewInvoice} />}
          {section === 'compras' && <OperationList type="compras" rows={data} onCreate={() => setModal(true)} onView={viewInvoice} />}
          {['productos', 'clientes', 'proveedores'].includes(section) && <CatalogList type={section} rows={data} onCreate={() => { setEditingRecord(null); setModal(true) }} onEdit={(record) => { setEditingRecord(record); setModal(true) }} onDeactivate={deactivate} />}
          {section === 'diario' && <JournalView rows={data} filters={filters} setFilters={setFilters} />}
          {section === 'mayor' && <LedgerView data={data} accounts={lookups.cuentas} filters={filters} setFilters={setFilters} />}
          {section === 'iva' && <VatView data={data} filters={filters} setFilters={setFilters} onSettle={settleVat} busy={busy} />}
          {!sections.some((item) => item.id === section) && <div className="page-heading"><div className="eyebrow">EMPRESA</div><h1>Configuración</h1><p>APEX SOFTWARE · Desarrollo, personalización y mantenimiento de paginas web</p><p>Clientes: empresas, negocios, emprendimientos y personas interesadas. Costos: desarrollo inicial (CapEx), más dominio, hosting, certificados SSL y mantenimiento técnico continuo (OpEx).</p></div>}
        </div>
      </main>

      {modal && <Modal onClose={() => { setModal(false); setPartyModalType(null) }}>
        {['ventas', 'compras'].includes(section)
          ? <OperationForm key={createdParty?.id || 'new-operation'} type={section} lookups={lookups} createdParty={createdParty} onAddParty={() => { setCreatedParty(null); setPartyModalType(section === 'ventas' ? 'clientes' : 'proveedores') }} onSubmit={submitOperation} onCancel={() => { setModal(false); setPartyModalType(null) }} />
          : <CatalogForm type={section} initialRecord={editingRecord} onSubmit={submitCatalog} onCancel={() => setModal(false)} />}
      </Modal>}
      {invoice && <Modal onClose={() => setInvoice(null)}><InvoiceView invoice={invoice} onClose={() => setInvoice(null)} /></Modal>}
      {partyModalType && <Modal onClose={() => setPartyModalType(null)}><CatalogForm type={partyModalType} onSubmit={(payload) => submitInlineParty(partyModalType, payload)} onCancel={() => setPartyModalType(null)} /></Modal>}
      {mobileMenu && <button className="mobile-scrim" aria-label="Cerrar menú" onClick={() => setMobileMenu(false)} />}
    </div>
  )
}

// Encabezado comun para que cada modulo presente contexto y accion principal.
function PageHeading({ eyebrow, title, detail, action }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{detail && <p>{detail}</p>}</div>{action}</div>
}

// Resume actividad mensual, posicion de IVA, alertas de inventario y accesos frecuentes.
function Dashboard({ data, navigate }) {
  const net = Number(data.iva_debito || 0) - Number(data.iva_credito || 0)
  return <>
    <PageHeading eyebrow={`PANEL GENERAL / ${currentPeriodLabel.toLocaleUpperCase('es-AR')}`} title="Buen día, equipo." detail="Así se mueve APEX SOFTWARE este mes." />
    <section className="metrics-grid" aria-label="Indicadores del mes">
      <Metric label="Ventas netas" value={money(data.ventas_netas)} icon={ArrowUpRight} tone="green" hint="este mes" />
      <Metric label="Compras netas" value={money(data.compras_netas)} icon={ArrowDownLeft} tone="orange" hint="este mes" />
      <Metric label="IVA débito" value={money(data.iva_debito)} icon={FileText} tone="blue" hint="ventas" />
      <Metric label="IVA crédito" value={money(data.iva_credito)} icon={CreditCard} tone="purple" hint="compras" />
    </section>
    <section className="dashboard-grid">
      <div className="panel main-panel">
        <div className="panel-head"><div><div className="eyebrow">ACTIVIDAD</div><h2>Últimas operaciones</h2></div><button className="text-action" onClick={() => navigate('ventas')}>Ver operaciones <ArrowUpRight size={15} /></button></div>
        <div className="operation-feed">{(data.operaciones_recientes || []).length ? data.operaciones_recientes.map((row, index) => <div className="feed-row" key={`${row.tipo}-${row.comprobante}-${index}`}>
          <span className={`feed-icon ${row.tipo === 'VENTA' ? 'feed-sale' : 'feed-buy'}`}>{row.tipo === 'VENTA' ? <ArrowUpRight size={17} /> : <ArrowDownLeft size={17} />}</span>
          <span className="feed-main"><b>{row.tipo === 'VENTA' ? 'Venta registrada' : 'Compra registrada'}</b><small>{row.comprobante}</small></span>
          <span className="feed-date">{dateLabel(row.fecha)}</span><strong className="feed-total">{money(row.total)}</strong>
        </div>) : <EmptyState label="Todavía no hay operaciones registradas." />}</div>
      </div>
      <div className="panel tax-panel">
        <div className="panel-head"><div><div className="eyebrow">POSICIÓN FISCAL</div><h2>IVA del período</h2></div><span className="tax-mark">21%</span></div>
        <div className="tax-lines"><div><span>Débito fiscal</span><b>{money(data.iva_debito)}</b></div><div><span>Crédito fiscal</span><b>{money(data.iva_credito)}</b></div></div>
        <div className={`tax-result ${net < 0 ? 'credit' : ''}`}><span>{net < 0 ? 'Saldo a favor' : 'IVA a pagar'}</span><strong>{money(Math.abs(net))}</strong><button onClick={() => navigate('iva')}>Ver liquidación <ArrowUpRight size={14} /></button></div>
      </div>
      <div className="panel stock-panel">
        <div className="panel-head"><div><div className="eyebrow">INVENTARIO</div><h2>Stock por reponer</h2></div><button className="round-link" onClick={() => navigate('productos')} aria-label="Ver productos"><ArrowUpRight size={16} /></button></div>
        {(data.bajo_stock || []).length ? <div className="stock-list">{data.bajo_stock.map((product) => <div className="stock-row" key={product.id}><span className="product-glyph"><Boxes size={17} /></span><b>{product.nombre}</b><span className={`stock-count ${Number(product.stock) === 0 ? 'empty' : ''}`}>{product.stock} un.</span></div>)}</div> : <EmptyState label="No hay productos con bajo stock." />}
      </div>
      <div className="quick-panel"><div><div className="eyebrow">ACCESO RÁPIDO</div><h2>¿Qué vas a registrar?</h2><p>Agregá una operación al libro contable.</p></div><div className="quick-actions"><button onClick={() => navigate('ventas')}><span><ShoppingCart size={18} /></span>Nueva venta<ArrowUpRight size={15} /></button><button onClick={() => navigate('compras')}><span><ShoppingBag size={18} /></span>Nueva compra<ArrowUpRight size={15} /></button></div></div>
    </section>
  </>
}

// Presenta una cifra del resumen con formato monetario y una categoria visual.
function Metric({ label, value, icon: Icon, tone, hint }) {
  return <div className={`metric metric-${tone}`}><span className="metric-icon"><Icon size={18} /></span><div className="metric-label">{label}<span>{hint}</span></div><strong>{value || money(0)}</strong><span className="metric-rule" /></div>
}

// Lista comprobantes y totales para ventas o compras, usando la misma tabla para ambos ciclos.
function OperationList({ type, rows, onCreate, onView }) {
  const sale = type === 'ventas'
  const operations = Array.isArray(rows) ? rows : []
  return <>
    <PageHeading eyebrow={sale ? 'CICLO COMERCIAL / INGRESOS' : 'CICLO COMERCIAL / EGRESOS'} title={sale ? 'Ventas' : 'Compras'} detail={sale ? 'Comprobantes emitidos e impacto en caja.' : 'Facturas recibidas y movimientos de inventario.'}
      action={<button className="button primary" onClick={onCreate}><Plus size={17} />{sale ? 'Nueva venta' : 'Nueva compra'}</button>} />
    <div className="table-toolbar"><div className="table-count">{operations.length} operaciones</div></div>
    <div className="table-wrap"><table><thead><tr><th>COMPROBANTE</th><th>{sale ? 'CLIENTE' : 'PROVEEDOR'}</th><th>FECHA</th><th>NETO</th><th>IVA</th><th className="align-right">TOTAL</th><th></th></tr></thead><tbody>
      {operations.map((row) => <tr key={row.id}><td><span className="doc-code">{row.tipo_comprobante?.replace('_', ' ')}</span><b>{row.numero_comprobante}</b></td><td>{row.contraparte}</td><td>{dateLabel(row.fecha)}</td><td>{money(row.neto)}</td><td>{money(row.iva)}</td><td className="align-right amount">{money(row.total)}</td><td><button className="text-action" onClick={() => onView(row.id)}>Ver factura</button></td></tr>)}
      {!operations.length && <tr><td colSpan="7"><EmptyState label="No hay operaciones para mostrar." /></td></tr>}
    </tbody></table></div>
  </>
}

// Factura imprimible: la letra A/B del comprobante define si el IVA se discrimina.
function InvoiceView({ invoice, onClose }) {
  const letter = invoice.tipo_comprobante.slice(-1)
  const discriminates = letter === 'A'
  const [downloading, setDownloading] = useState(false)
  const [pdfError, setPdfError] = useState('')
  // El PDF se genera en el servidor sobre la plantilla de facturación en blanco.
  async function downloadPdf() {
    setDownloading(true)
    setPdfError('')
    try {
      const { data } = await api.get(`/${invoice.esVenta ? 'ventas' : 'compras'}/${invoice.id}/pdf`, { responseType: 'blob' })
      const url = URL.createObjectURL(data)
      const link = document.createElement('a')
      link.href = url
      link.download = `factura-${letter}-${invoice.numero_comprobante}.pdf`
      link.click()
      URL.revokeObjectURL(url)
    } catch (requestError) {
      setPdfError(errorMessage(requestError))
    } finally {
      setDownloading(false)
    }
  }
  return <div className="invoice-sheet">
    <div className="modal-heading no-print"><div><div className="eyebrow">{invoice.esVenta ? 'FACTURA DE VENTA' : 'FACTURA DE COMPRA'}</div><h2>Factura {letter} {invoice.numero_comprobante}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar"><X size={19} /></button></div>
    {pdfError && <div className="notice error no-print">{pdfError}</div>}
    <div className="invoice-head"><div><h3>APEX SOFTWARE</h3><small>{invoice.esVenta ? 'Emisor' : 'Receptor'}</small></div><div className="invoice-letter"><b>{letter}</b><small>{invoice.esVenta ? 'Original' : 'Recibida'}</small></div><div><b>Nº {invoice.numero_comprobante}</b><br />Fecha: {dateLabel(invoice.fecha)}</div></div>
    <div className="invoice-party"><b>{invoice.esVenta ? 'Cliente' : 'Proveedor'}:</b> {invoice.contraparte}<br />CUIT/Doc: {invoice.contraparte_cuit || '—'} · Condición IVA: {invoice.contraparte_condicion_iva?.replaceAll('_', ' ')}<br />Domicilio: {invoice.contraparte_domicilio || '—'}</div>
    <div className="table-wrap"><table><thead><tr><th>PRODUCTO</th><th>CANT.</th><th>P. UNIT. {discriminates ? 'NETO' : ''}</th><th className="align-right">{discriminates ? 'SUBTOTAL NETO' : 'SUBTOTAL'}</th></tr></thead><tbody>
      {invoice.detalle.map((line, index) => <tr key={index}><td>{line.producto}</td><td>{line.cantidad}</td><td>{money(line.precio_unitario)}</td><td className="align-right">{money(discriminates ? line.neto : line.total)}</td></tr>)}
    </tbody></table></div>
    <div className="totals-block">{discriminates && <><div><span>Neto</span><b>{money(invoice.neto)}</b></div><div><span>IVA 21%</span><b>{money(invoice.iva)}</b></div></>}<div className="grand-total"><span>Total</span><strong>{money(invoice.total)}</strong></div></div>
    {invoice.pagos?.length > 0 && <p className="invoice-payments">Pagos: {invoice.pagos.map((pago) => `${pago.forma_pago} ${money(pago.importe)}${Number(pago.recargo_importe) > 0 ? ` (+${pago.recargo_porcentaje}% recargo ${money(pago.recargo_importe)})` : ''}`).join(' · ')}</p>}
    <div className="modal-actions no-print"><button type="button" className="button secondary" onClick={onClose}>Cerrar</button><button type="button" className="button primary" disabled={downloading} onClick={downloadPdf}>{downloading ? 'Generando…' : 'Descargar PDF'}</button></div>
  </div>
}

// Muestra productos/clientes/proveedores y delega alta, edicion y baja a la pantalla principal.
function CatalogList({ type, rows, onCreate, onEdit, onDeactivate }) {
  const records = Array.isArray(rows) ? rows : []
  const config = {
    productos: { title: 'Productos', eyebrow: 'INVENTARIO / CATÁLOGO', detail: 'Costos, precios de venta y existencias.' },
    clientes: { title: 'Clientes', eyebrow: 'CARTERA / CLIENTES', detail: 'Empresas, negocios, emprendimientos y personas interesadas en Apex Software.' },
    proveedores: { title: 'Proveedores', eyebrow: 'ABASTECIMIENTO / PROVEEDORES', detail: 'Empresas que abastecen el inventario.' },
  }[type]
  const product = type === 'productos'
  const party = type !== 'productos'
  return <>
    <PageHeading {...config} action={<button className="button primary" onClick={onCreate}><Plus size={17} />Nuevo registro</button>} />
    <div className="table-toolbar"><div className="table-count">{records.length} registros activos</div></div>
    <div className="table-wrap"><table><thead><tr>{product ? <><th>PRODUCTO</th><th>PRECIO DE VENTA</th><th /></> : <><th>RAZÓN SOCIAL</th><th>IDENTIFICACIÓN</th><th>DOMICILIO</th><th>CONDICIÓN IVA</th><th /></>}</tr></thead><tbody>
      {records.map((row) => <tr key={row.id}>{product ? <><td><b>{row.nombre}</b><small className="cell-sub">{row.descripcion || 'Sistema digital'}</small></td><td className="amount">{money(row.precio_venta)}</td></> : <><td><b>{row.razon_social}</b></td><td>{row.identificacion || row.cuit || '—'}</td><td>{row.domicilio || '—'}</td><td><span className="status-label">{row.condicion_iva?.replaceAll('_', ' ')}</span></td></>}
        <td className="align-right"><button className="icon-button" title="Editar" onClick={() => onEdit(row)}><Pencil size={15} /></button><button className="icon-button danger-action" title="Desactivar" onClick={() => onDeactivate(row.id)}><X size={16} /></button></td></tr>)}
      {!records.length && <tr><td colSpan={party ? 5 : 5}><EmptyState label="Todavía no hay registros activos." /></td></tr>}
    </tbody></table></div>
  </>
}

// Consulta visual del libro diario; los filtros se reflejan en la solicitud al API.
function JournalView({ rows, filters, setFilters }) {
  const entries = Array.isArray(rows) ? rows : []
  return <>
    <PageHeading eyebrow="CONTABILIDAD / REGISTROS" title="Libro Diario" detail="Asientos cronológicos con detalle por cuenta." />
    <div className="filters-row"><label>Desde<input type="date" value={filters.desde} onChange={(event) => setFilters((old) => ({ ...old, desde: event.target.value }))} /></label><label>Hasta<input type="date" value={filters.hasta} onChange={(event) => setFilters((old) => ({ ...old, hasta: event.target.value }))} /></label><label>Tipo<select value={filters.tipo} onChange={(event) => setFilters((old) => ({ ...old, tipo: event.target.value }))}><option value="">Todos</option><option value="VENTA">Venta</option><option value="CMV">CMV</option><option value="COMPRA">Compra</option><option value="LIQUIDACION_IVA">Liquidación IVA</option><option value="APERTURA">Apertura</option></select></label></div>
    <div className="table-wrap"><table><thead><tr><th>ASIENTO</th><th>FECHA</th><th>CONCEPTO / CUENTA</th><th>DEBE</th><th className="align-right">HABER</th></tr></thead><tbody>
      {entries.map((row) => <tr key={`${row.asiento_id}-${row.cuenta_codigo}`}><td><span className="journal-number">#{String(row.asiento_id).padStart(5, '0')}</span><small className="cell-sub">{row.tipo_operacion}</small></td><td>{dateLabel(row.fecha)}</td><td><b>{row.descripcion}</b><small className="cell-sub">{row.cuenta_codigo} · {row.cuenta}</small></td><td>{Number(row.debe) ? money(row.debe) : '—'}</td><td className="align-right">{Number(row.haber) ? money(row.haber) : '—'}</td></tr>)}
      {!entries.length && <tr><td colSpan="5"><EmptyState label="No hay asientos para este filtro." /></td></tr>}
    </tbody></table></div>
  </>
}

// Muestra los movimientos acumulados de una cuenta elegida del plan contable.
function LedgerView({ data, accounts, filters, setFilters }) {
  return <>
    <PageHeading eyebrow="CONTABILIDAD / MAYOR" title="Mayor por cuenta" detail="Movimientos y saldo acumulado de una cuenta." />
    <div className="filters-row"><label className="wide-filter">Cuenta<select value={filters.cuentaId || accounts[0]?.id || ''} onChange={(event) => setFilters((old) => ({ ...old, cuentaId: event.target.value }))}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.codigo} · {account.nombre}</option>)}</select></label></div>
    <div className="table-wrap"><table><thead><tr><th>FECHA</th><th>CONCEPTO</th><th>DEBE</th><th>HABER</th><th className="align-right">SALDO</th></tr></thead><tbody>
      {(data.movimientos || []).map((row, index) => <tr key={`${row.fecha}-${index}`}><td>{dateLabel(row.fecha)}</td><td>{row.descripcion}</td><td>{Number(row.debe) ? money(row.debe) : '—'}</td><td>{Number(row.haber) ? money(row.haber) : '—'}</td><td className="align-right amount">{money(row.saldo)}</td></tr>)}
      {!data.movimientos?.length && <tr><td colSpan="5"><EmptyState label="Esta cuenta todavía no tiene movimientos." /></td></tr>}
    </tbody></table></div>
  </>
}

// Compara debito y credito fiscal y permite registrar una sola liquidacion mensual.
function VatView({ data, filters, setFilters, onSettle, busy }) {
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
  const favor = data.resultado === 'SALDO_A_FAVOR'
  return <>
    <PageHeading eyebrow="IMPUESTOS / POSICIÓN FISCAL" title="Liquidación de IVA" detail="Cierre mensual del débito y crédito fiscal." />
    <div className="filters-row vat-period"><label>Mes<select value={filters.mes} onChange={(event) => setFilters((old) => ({ ...old, mes: Number(event.target.value) }))}>{months.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label><label>Año<input type="number" min="2000" max="9999" value={filters.anio} onChange={(event) => setFilters((old) => ({ ...old, anio: Number(event.target.value) }))} /></label></div>
    <section className="vat-layout"><div className="vat-breakdown panel"><div className="panel-head"><div><div className="eyebrow">RESUMEN FISCAL</div><h2>{months[Number(filters.mes) - 1]} {filters.anio}</h2></div><span className="status-label">IVA general · 21%</span></div><div className="vat-row"><span><i className="vat-dot debit-dot" />IVA Débito Fiscal</span><b>{money(data.iva_debito)}</b></div><div className="vat-row"><span><i className="vat-dot credit-dot" />IVA Crédito Fiscal</span><b>{money(data.iva_credito)}</b></div><div className="vat-equation"><span>Débito − Crédito</span><b>{money(data.saldo)}</b></div><div className={`vat-outcome ${favor ? 'favor' : ''}`}><div><span>{favor ? 'Saldo a favor' : data.resultado === 'SIN_SALDO' ? 'Sin saldo' : 'IVA a pagar'}</span><strong>{money(Math.abs(Number(data.saldo || 0)))}</strong></div><span className="outcome-icon">{favor ? <ArrowDownLeft size={21} /> : <ArrowUpRight size={21} />}</span></div></div>
      <aside className="vat-aside"><div className="eyebrow">CIERRE DEL PERÍODO</div><h2>{data.liquidada ? 'Período liquidado' : 'Listo para liquidar'}</h2><p>{data.liquidada ? 'El asiento de cierre quedó registrado en el Libro Diario.' : 'Se generará el asiento de cierre y se bloqueará una segunda liquidación del mismo período.'}</p><button className="button primary full" onClick={onSettle} disabled={busy || data.liquidada}><Check size={17} />{data.liquidada ? 'Liquidación registrada' : 'Generar liquidación'}</button><small>Una vez liquidado, el período no se puede liquidar de nuevo.</small></aside></section>
  </>
}

// Construye el payload de venta/compra; los importes mostrados son una vista previa y el servidor recalcula.
function OperationForm({ type, lookups, createdParty, onAddParty, onSubmit, onCancel }) {
  const sale = type === 'ventas'
  const [partyId, setPartyId] = useState(createdParty ? String(createdParty.id) : '')
  const [items, setItems] = useState([{ producto_id: '', cantidad: 1, precio_unitario: '' }])
  const [paymentRows, setPaymentRows] = useState([{ forma_pago_id: '', importe: '' }])
  const [fecha, setFecha] = useState(today)
  const [numero, setNumero] = useState('')
  const [tipo, setTipo] = useState('FACTURA_A')
  const [monotributista, setMonotributista] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const priceFor = (item) => {
    if (item.libre) return Number(item.precio_unitario) || 0
    const product = lookups.productos.find((row) => String(row.id) === String(item.producto_id))
    return Number(item.precio_unitario !== '' ? item.precio_unitario : sale ? product?.precio_venta : product?.costo_unitario) || 0
  }
  // La interfaz anticipa el total para orientar el pago; la validacion definitiva ocurre en el backend.
  const net = items.reduce((total, item) => total + Math.round(priceFor(item) * Number(item.cantidad || 0) * 100) / 100, 0)
  const tax = (!sale && tipo === 'FACTURA_B') || (sale && monotributista) ? 0 : Math.round(net * 0.21 * 100) / 100
  const total = net + tax
  const setItem = (index, key, value) => setItems((old) => old.map((item, i) => i === index ? { ...item, [key]: value } : item))
  const setPayment = (index, key, value) => setPaymentRows((old) => old.map((item, i) => i === index ? { ...item, [key]: value } : item))

  // Convierte los controles del formulario al contrato JSON que espera el servicio de operaciones.
  async function submit(event) {
    event.preventDefault()
    setError('')
    setSaving(true)
    const payments = paymentRows.map((row, index) => ({
      forma_pago_id: Number(row.forma_pago_id),
      importe: Number(row.importe || (paymentRows.length === 1 && index === 0 ? total : 0)),
      recargo_porcentaje: Number(row.recargo_porcentaje || 0),
    }))
    const payload = {
      ...(sale ? { cliente_id: Number(partyId), emisor_monotributista: monotributista } : { proveedor_id: Number(partyId), numero_comprobante: numero, tipo_comprobante: tipo }),
      fecha,
      items: items.map((item) => item.libre
        ? { descripcion: item.descripcion.trim(), cantidad: Number(item.cantidad), precio_unitario: Number(item.precio_unitario) }
        : { producto_id: Number(item.producto_id), cantidad: Number(item.cantidad),
          ...(!sale || item.precio_unitario !== '' ? { precio_unitario: Number(item.precio_unitario || priceFor(item)) } : {}) }),
      pagos: payments,
    }
    try { await onSubmit(payload) } catch (requestError) { setError(errorMessage(requestError)) } finally { setSaving(false) }
  }

  const partyList = sale ? lookups.clientes : lookups.proveedores
  return <form className="operation-form" onSubmit={submit}>
    <div className="modal-heading"><div><div className="eyebrow">NUEVA OPERACIÓN</div><h2>{sale ? 'Registrar venta' : 'Registrar compra'}</h2></div><button type="button" className="icon-button" onClick={onCancel} aria-label="Cerrar"><X size={19} /></button></div>
    {error && <div className="notice error">{error}</div>}
    <div className="form-grid"><div className="party-field"><label>{sale ? 'Cliente' : 'Proveedor'}<select required value={partyId} onChange={(event) => setPartyId(event.target.value)}><option value="">Seleccionar…</option>{partyList.map((row) => <option key={row.id} value={row.id}>{row.razon_social}</option>)}</select></label><button type="button" className="text-action" onClick={onAddParty}><Plus size={14} />Agregar {sale ? 'cliente' : 'proveedor'}</button></div><label>Fecha<input required type="date" value={fecha} onChange={(event) => setFecha(event.target.value)} /></label>{sale && <label className="check-field"><span>Facturación</span><span><input type="checkbox" checked={monotributista} onChange={(event) => setMonotributista(event.target.checked)} /> Monotributista (Factura C, sin IVA)</span></label>}{!sale && <><label>Tipo de factura<select value={tipo} onChange={(event) => setTipo(event.target.value)}><option value="FACTURA_A">Factura A (discrimina IVA)</option><option value="FACTURA_B">Factura B (sin crédito fiscal)</option></select></label><label>Número de factura del proveedor<input required value={numero} onChange={(event) => setNumero(event.target.value)} placeholder="0001-00001234" /></label></>}</div>    <div className="form-section-head"><b>Productos</b><span><button type="button" className="text-action" onClick={() => setItems((old) => [...old, { producto_id: '', cantidad: 1, precio_unitario: '' }])}><Plus size={14} />Agregar línea</button>{!sale && <button type="button" className="text-action" onClick={() => setItems((old) => [...old, { libre: true, descripcion: '', cantidad: 1, precio_unitario: '' }])}><Plus size={14} />Producto no catalogado</button>}</span></div>
    <div className="line-items">{items.map((item, index) => <div className="line-item" key={index}>{item.libre ? <input aria-label="Descripción" required maxLength={180} placeholder="Nombre del producto o servicio" value={item.descripcion} onChange={(event) => setItem(index, 'descripcion', event.target.value)} /> : <select aria-label="Producto" required value={item.producto_id} onChange={(event) => setItem(index, 'producto_id', event.target.value)}><option value="">Producto…</option>{lookups.productos.map((product) => <option key={product.id} value={product.id}>{product.nombre} · {sale ? product.stock : 'stock ' + product.stock}</option>)}</select>}<input aria-label="Cantidad" required type="number" min="1" step="1" value={item.cantidad} onChange={(event) => setItem(index, 'cantidad', event.target.value)} />{!sale && <input aria-label="Precio unitario" required type="number" min="0" step="0.01" placeholder="Precio neto" value={item.precio_unitario} onChange={(event) => setItem(index, 'precio_unitario', event.target.value)} />}<b className="line-total">{money(priceFor(item) * Number(item.cantidad || 0))}</b>{items.length > 1 && <button type="button" className="icon-button danger-action" aria-label="Quitar producto" onClick={() => setItems((old) => old.filter((_, i) => i !== index))}><X size={15} /></button>}</div>)}</div>
    <div className="form-section-head"><b>Formas de pago</b><button type="button" className="text-action" onClick={() => setPaymentRows((old) => [...old, { forma_pago_id: '', importe: '' }])}><Plus size={14} />Dividir pago</button></div>
    <div className="payment-list">{paymentRows.map((payment, index) => <div className="payment-row" key={index}><select required value={payment.forma_pago_id} onChange={(event) => setPayment(index, 'forma_pago_id', event.target.value)}><option value="">Forma de pago…</option>{lookups.formas.map((row) => <option key={row.id} value={row.id}>{row.nombre}</option>)}</select><input required type="number" min="0.01" step="0.01" placeholder="Importe" value={payment.importe || (paymentRows.length === 1 && total ? total.toFixed(2) : '')} onChange={(event) => setPayment(index, 'importe', event.target.value)} /><input type="number" min="0" max="1000" step="0.01" placeholder="Recargo %" title="Recargo porcentual de esta forma de pago" value={payment.recargo_porcentaje ?? ''} onChange={(event) => setPayment(index, 'recargo_porcentaje', event.target.value)} />{paymentRows.length > 1 && <button type="button" className="icon-button danger-action" aria-label="Quitar pago" onClick={() => setPaymentRows((old) => old.filter((_, i) => i !== index))}><X size={15} /></button>}{Number(payment.recargo_porcentaje) > 0 && <small className="cell-sub">Se cobra/paga {money(Math.round(Number(payment.importe || (paymentRows.length === 1 ? total : 0)) * (1 + Number(payment.recargo_porcentaje) / 100) * 100) / 100)}</small>}</div>)}</div>
    <div className="totals-block"><div><span>Neto</span><b>{money(net)}</b></div><div><span>{(!sale && tipo === 'FACTURA_B') ? 'IVA (no discriminado)' : sale && monotributista ? 'IVA (no aplica)' : 'IVA 21%'}</span><b>{money(tax)}</b></div><div className="grand-total"><span>Total</span><strong>{money(total)}</strong></div></div>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onCancel}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? 'Guardando…' : sale ? 'Registrar venta' : 'Registrar compra'}<ArrowUpRight size={16} /></button></div>
  </form>
}

// Formulario reutilizable de productos, clientes y proveedores, con campos segun el catalogo elegido.
function CatalogForm({ type, initialRecord, onSubmit, onCancel }) {
  const title = { productos: 'Nuevo producto', clientes: 'Nuevo cliente', proveedores: 'Nuevo proveedor' }[type]
  const [cost, setCost] = useState(initialRecord?.costo_unitario || '')
  const [price, setPrice] = useState(initialRecord?.precio_venta || '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // Normaliza valores del formulario para crear/editar; el backend aplica las reglas finales.
  async function submit(event) {
    event.preventDefault()
    setError('')
    setSaving(true)
    const form = new FormData(event.currentTarget)
    let payload
    if (type === 'productos') payload = {
      nombre: form.get('nombre'), descripcion: form.get('descripcion'),
      ...(!initialRecord ? { stock: Number(form.get('stock') || 0) } : {}),
      costo_unitario: Number(cost || 0), precio_venta: Number(price || Number(cost || 0) * 1.4),
    }
    else payload = { razon_social: form.get('razon_social'), identificacion: form.get('identificacion') || null, cuit: form.get('identificacion') || undefined, domicilio: form.get('domicilio'), condicion_iva: form.get('condicion_iva') }
    try { await onSubmit(payload, initialRecord?.id) } catch (requestError) { setError(errorMessage(requestError)) } finally { setSaving(false) }
  }
  return <form className="catalog-form" onSubmit={submit}>
    <div className="modal-heading"><div><div className="eyebrow">CATÁLOGO / {initialRecord ? 'EDICIÓN' : 'ALTA'}</div><h2>{initialRecord ? title.replace('Nuevo ', 'Editar ') : title}</h2></div><button type="button" className="icon-button" onClick={onCancel} aria-label="Cerrar"><X size={19} /></button></div>
    {error && <div className="notice error">{error}</div>}
    {type === 'productos' ? <div className="form-grid"><label className="form-span">Nombre<input name="nombre" defaultValue={initialRecord?.nombre || ''} required /></label><label className="form-span">Descripción<input name="descripcion" defaultValue={initialRecord?.descripcion || ''} /></label><label>Stock actual<input name="stock" type="number" min="0" step="1" defaultValue={initialRecord?.stock ?? 0} readOnly={Boolean(initialRecord)} required /></label><label>Costo unitario<input type="number" min="0" step="0.01" value={cost} onChange={(event) => { setCost(event.target.value); if (!initialRecord && !price) setPrice((Number(event.target.value) * 1.4).toFixed(2)) }} required /></label><label className="form-span">Precio de venta<input type="number" min="0" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} required /></label></div>
      : <div className="form-grid"><label className="form-span">Razón social / nombre<input name="razon_social" defaultValue={initialRecord?.razon_social || ''} required /></label><label>{type === 'clientes' ? 'CUIT o DNI' : 'CUIT'}<input name="identificacion" defaultValue={initialRecord?.identificacion || initialRecord?.cuit || ''} required={type === 'proveedores'} /></label><label>Domicilio<input name="domicilio" defaultValue={initialRecord?.domicilio || ''} /></label><label className="form-span">Condición frente al IVA<select name="condicion_iva" defaultValue={initialRecord?.condicion_iva || 'RESPONSABLE_INSCRIPTO'}><option value="RESPONSABLE_INSCRIPTO">Responsable Inscripto</option>{type === 'clientes' ? <><option value="MONOTRIBUTISTA">Monotributista</option><option value="CONSUMIDOR_FINAL">Consumidor Final</option></> : <><option value="MONOTRIBUTISTA">Monotributista</option><option value="EXENTO">Exento</option></>}</select></label></div>}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onCancel}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? 'Guardando…' : initialRecord ? 'Guardar cambios' : 'Crear registro'}<Check size={16} /></button></div>
  </form>
}

// Cierra por Escape o clic en el fondo y retira el listener al desmontarse.
function Modal({ children, onClose }) {
  useEffect(() => {
    const close = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal-panel">{children}</section></div>
}

// Mensaje comun para listas y tablas sin registros.
function EmptyState({ label }) {
  return <div className="empty-state"><span><ClipboardList size={19} /></span>{label}</div>
}

export default App
