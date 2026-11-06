// ─────────────────────────────────────────────────────────────────────────────
// Ferco Planificación — conector MCP (fase 1 "light").
//
// Capa delgada: cada herramienta es una llamada a /api/planificacion/* del app de
// Picking, reenviando el pase (Bearer) que Supabase Auth le dio a Claude. Este
// servicio NO tiene credenciales de BD, Supabase ni UiPath; el app valida el pase,
// aplica permisos (módulo 'planificacion' + centros + 'priorizacion' para escribir)
// y audita cada llamada. Las escrituras son en dos pasos (vista previa + confirmar).
// Transporte Streamable HTTP sin estado + descubrimiento OAuth (RFC 9728).
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const PORT = process.env.PORT || 3002;
const API = (process.env.PLAN_API_URL || 'http://localhost:3001').replace(/\/$/, '') + '/api/planificacion';
const PUBLIC_URL = (process.env.PLAN_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const AUTH_SERVER = process.env.PLAN_AUTH_SERVER || null;
const ALLOWED_ORIGINS = (process.env.PLAN_ALLOWED_ORIGINS || 'https://claude.ai,https://claude.com').split(',').map(s => s.trim());
const RESOURCE = `${PUBLIC_URL}/mcp`;
const RESOURCE_METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;

// ── Cliente del app ──────────────────────────────────────────────────────────
class ApiError extends Error { constructor(status, body) { super(body && body.error ? body.error : `HTTP ${status}`); this.status = status; this.body = body; } }
async function api(token, path, { query, body } = {}) {
    const url = new URL(API + path);
    Object.entries(query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
    const r = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
    if (!r.ok) throw new ApiError(r.status, data);
    return data;
}

// ── Herramientas ─────────────────────────────────────────────────────────────
const centroArg = z.number().int().optional().describe('ID del centro (3 = HUB Escuintla). Si el usuario tiene un solo centro se puede omitir.');
const fechaArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const confirmarArg = z.string().optional().describe('Token devuelto por la vista previa. SOLO se envía después de que el usuario aprobó explícitamente la vista previa; sin él la herramienta no cambia nada.');
const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
const toolError = (e) => {
    if (!(e instanceof ApiError)) return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    const extra = e.body && typeof e.body === 'object' ? Object.fromEntries(Object.entries(e.body).filter(([k]) => k !== 'error')) : {};
    return { isError: true, content: [{ type: 'text', text: `El app respondió ${e.status}: ${e.message}` + (Object.keys(extra).length ? `\n${JSON.stringify(extra, null, 1)}` : '') }] };
};
const run = (fn) => async (args) => { try { return json(await fn(args || {})); } catch (e) { return toolError(e); } };

const INSTRUCCIONES = `Conector de planificación de rutas del HUB Escuintla (centro 3).
Empieza con \`yo\` para conocer rol y centros. Lecturas: backlog (snapshot cada 15 min), cola, cuadros, documentos, capacidad y orden del día; todo viene del app de Picking, sin consultas en vivo a SAP/Lisa.
ESCRITURAS EN DOS PASOS: cada herramienta de escritura, llamada sin \`confirmar\`, devuelve una vista previa y un token. Muestra la vista previa al usuario y SOLO si lo aprueba explícitamente vuelve a llamar con los mismos argumentos y \`confirmar\` = token (vence en 15 min, un solo uso). Nunca confirmes por tu cuenta. Las escrituras quedan en el app y en el Sync/staging; SAP solo lo tocan los robots de UiPath.`;

function buildServer(token) {
    const server = new McpServer({ name: 'ferco-planificacion', version: '0.2.0' }, { instructions: INSTRUCCIONES });
    const t = (name, description, schema, fn) => server.registerTool(name, { description, inputSchema: schema }, run((a) => fn(a)));

    // ── Lectura ──
    t('yo', 'Quién soy en el app de Picking: nombre, correo, rol y centros que puedo consultar.', {}, () => api(token, '/yo'));

    t('backlog_sin_cuadro', 'OV, TR y RMA en preparación (U_Estado2=03) del almacén del centro que NO tienen cuadro de ruta en SAP, con kg, fecha de entrega, forma de envío, líneas sin stock, si ya está pickeado/entregado en Lisa, último cuadro en el app (rezago), escalamiento y categoría. Snapshot cada 15 min (revisa `corte` y `edadMinutos`). Por defecto excluye lo que no se planifica (cliente retira, TR ya operados en Lisa).', {
        centro: centroArg,
        categoria: z.enum(['nuevo', 'rezago', 'paqueteria', 'exportacion', 'no_aplica_cliente_retira', 'no_aplica_tr_operado_lisa']).optional(),
        tipo: z.enum(['OV', 'TR', 'RMA']).optional(),
        incluir_no_aplica: z.boolean().optional().describe('true para ver también cliente retira y TR operados en Lisa')
    }, (a) => api(token, '/backlog', { query: a }));

    t('cola_cuadros', 'Cola de cuadros Pendiente/Iniciado del centro en orden de prioridad: fecha plan, Comprometida, toneladas planificadas y por pickear, paradas, documentos, tipo de camión (del nombre) y grupo (tiendas/expos/ultima_milla). Úsala para tomar `esperado` antes de fijar prioridad.', {
        centro: centroArg,
        hasta: fechaArg.optional().describe('Solo cuadros con fecha plan <= esta fecha (AAAA-MM-DD)'),
        sin_fecha: z.boolean().optional().describe('false para excluir cuadros sin fecha plan')
    }, (a) => api(token, '/cola', { query: a }));

    t('detalle_cuadro', 'Documentos de un cuadro con cliente, kg planificados y por pickear (avance del picking en el app) y bultos/licencias ya capturados.', {
        numero: z.number().int().describe('Número de cuadro (RouteNumber / DocNum en SAP)')
    }, (a) => api(token, `/cuadros/${a.numero}`));

    t('detalle_documento', 'Un documento (OV, TR o RMA): su fila del backlog si está sin cuadro (kg, cliente, dirección, comentarios, escalamiento, pickeado en Lisa según el snapshot), los cuadros del app donde está o estuvo con su avance, escalamientos abiertos y bultos capturados. Sin consulta en vivo a SAP.', {
        documento: z.string().describe('Número de OV, TR o RMA'),
        centro: centroArg,
        tipo: z.enum(['OV', 'TR', 'RMA']).optional().describe('Forzar el tipo si el número es ambiguo')
    }, (a) => api(token, `/documentos/${encodeURIComponent(a.documento)}`, { query: { centro: a.centro, tipo: a.tipo } }));

    t('escalamientos', 'Tickets de escalamiento abiertos (HUB Escuintla) con fecha requerida, cliente, kg y estado derivado del app: Pendiente (sin cuadro en el app), Programado (en cuadro) o Finalizado (despachado). Un cuadro que solo existe en SAP (p. ej. CEDI Zona 5) se ve como Pendiente.', {
        centro: centroArg,
        incluir_finalizados: z.boolean().optional()
    }, (a) => api(token, '/escalamientos', { query: a }));

    t('ritmo_picking', 'Toneladas y cuadros finalizados por día en el centro (ritmo real del piso).', {
        centro: centroArg, dias: z.number().int().min(1).max(60).optional().describe('Días hacia atrás (por defecto 7)')
    }, (a) => api(token, '/ritmo', { query: a }));

    t('estado_staging', 'Lotes recientes del staging de rutas (Supabase rutas_staging) que lee el robot de importación: estados por lote, rutas, errores, cuadros creados y lo que sigue pendiente. Revísalo antes de lanzar el robot: documentos vacíos o un mismo documento pendiente en dos lotes lo rompen o duplican cuadros.', {
        centro: centroArg, dias: z.number().int().min(1).max(60).optional()
    }, (a) => api(token, '/staging', { query: a }));

    t('estado_sync', 'Ediciones de cuadros pendientes o en error en el Sync hacia SAP (CuadroEdicionCola) y resumen de los últimos 7 días.', {
        centro: centroArg
    }, (a) => api(token, '/sync', { query: a }));

    t('validar_plan', 'Valida una propuesta SIN escribir: cuadros nuevos y documentos a agregar a cuadros existentes. Revisa capacidad y paradas por camión, 22T solo cliente único, clientes en plataforma de tiendas, documentos fuera del backlog, ya en otro cuadro del app, RMA en cuadro nuevo, repetidos y vacíos. Devuelve errores (bloquean) y avisos.', {
        centro: centroArg,
        cuadros: z.array(z.object({
            nombre: z.string().describe('Nombre del cuadro, p. ej. "06NOV MIXCO 3.5T" (el tipo de camión se toma del nombre)'),
            fecha: fechaArg.optional(),
            camion: z.string().optional().describe('Tipo de camión si no va en el nombre: 3.5T, 5T, 10T, 12T, 15T, 22T'),
            documentos: z.array(z.string()).describe('OV/TR/RMA que van en el cuadro')
        })).optional(),
        agregados: z.array(z.object({ cuadro: z.number().int(), documentos: z.array(z.string()) })).optional()
    }, (a) => api(token, '/validar-plan', { body: a }));

    t('capacidad_dia', 'Toneladas por pickear del día (incluye atrasados) por grupo tiendas/expos/ultima_milla contra el corte del centro, hora estimada de cada cambio de grupo y rutas pequeñas de última milla contra la meta.', {
        centro: centroArg, fecha: fechaArg.optional().describe('Por defecto hoy')
    }, (a) => api(token, '/capacidad-dia', { query: a }));

    t('proponer_orden_dia', 'Orden de picking propuesto para un día SIN escribir: iniciados y ya pickeados primero, luego comprometidos, luego cada grupo en el orden del centro (tiendas → expos → última milla); dentro del grupo, escalado más viejo y fecha más vieja. Marca el excedente sobre el corte y la hora estimada en que termina cada cuadro. Para aplicarlo se usa fijar_prioridad_fecha cuadro por cuadro.', {
        centro: centroArg, fecha: fechaArg.optional().describe('Por defecto hoy')
    }, (a) => api(token, '/orden-dia', { query: a }));

    // ── Escritura (dos pasos) ──
    const docsArg = z.array(z.union([z.string(), z.object({ documento: z.string(), tipo: z.enum(['OV', 'TR', 'RMA']).optional() })])).describe('Documentos; el tipo se infiere del backlog o del app, indícalo si no se conoce');

    t('agregar_docs_cuadro', 'Agrega documentos (OV, TR o RMA) a un cuadro Pendiente/Iniciado del app. Valida antes (capacidad, paradas, backlog). Sin `confirmar` devuelve la vista previa; con `confirmar` aplica: materializa las líneas y deja la orden ADD en el Sync (el usuario corre SyncEdicionesCuadro en UiPath para reflejarlo en SAP). Si el documento está en otro cuadro del app, lo mueve conservando el avance.', {
        centro: centroArg, cuadro: z.number().int(), documentos: docsArg, confirmar: confirmarArg
    }, (a) => api(token, `/cuadros/${a.cuadro}/agregar`, { body: { centro: a.centro, documentos: a.documentos, confirmar: a.confirmar } }));

    t('quitar_docs_cuadro', 'Quita documentos de un cuadro: destino "eliminar" (quedan No Despachada), {cuadro: N} (mover a otro cuadro vivo, conserva avance) o "nuevo" (complemento nuevo "... - COMP"). Vista previa sin `confirmar`; con `confirmar` aplica y deja las órdenes REMOVE/ADD en el Sync.', {
        centro: centroArg, cuadro: z.number().int(), documentos: docsArg,
        destino: z.union([z.literal('eliminar'), z.literal('nuevo'), z.object({ cuadro: z.number().int() })]).optional().describe('Por defecto "eliminar"'),
        confirmar: confirmarArg
    }, (a) => api(token, `/cuadros/${a.cuadro}/quitar`, { body: { centro: a.centro, documentos: a.documentos, destino: a.destino, confirmar: a.confirmar } }));

    t('crear_cuadros', 'Crea cuadros nuevos: valida el plan, carga las rutas al staging (un lote por cuadro, solo OV/TR) y lanza el robot de importación que crea los cuadros en SAP; el app los ingesta en ~5 min. Las RMA se agregan después con agregar_docs_cuadro. Vista previa sin `confirmar`.', {
        centro: centroArg,
        cuadros: z.array(z.object({
            nombre: z.string().describe('"DDMMM DESTINO [N] CAPACIDAD", máx. 75 caracteres; el camión se toma del nombre'),
            fecha: fechaArg.describe('Fecha plan de despacho'),
            camion: z.string().optional(),
            documentos: z.array(z.string())
        })),
        lanzar_robot: z.boolean().optional().describe('false para solo dejar el staging listo sin lanzar el robot'),
        confirmar: confirmarArg
    }, (a) => api(token, '/cuadros', { body: { centro: a.centro, cuadros: a.cuadros, lanzar_robot: a.lanzar_robot, confirmar: a.confirmar } }));

    t('lanzar_robot_rutas', 'Relanza el robot de importación de rutas (procesa TODO lo pendiente del staging, de todos los equipos). Revisa estado_staging antes. Vista previa sin `confirmar`.', {
        centro: centroArg, confirmar: confirmarArg
    }, (a) => api(token, '/robot/importar-rutas', { body: { centro: a.centro, confirmar: a.confirmar } }));

    t('fijar_prioridad_fecha', 'Fija la prioridad (inserta en ese lugar y corre el resto) y/o la fecha plan de un cuadro. Para cambiar prioridad hay que enviar `esperado` con la prioridad y fecha que viste en cola_cuadros: si alguien lo movió mientras tanto, se rechaza. Un cuadro iniciado no baja; uno Comprometido solo lo mueve un Admin. Vista previa sin `confirmar`.', {
        centro: centroArg, cuadro: z.number().int(),
        prioridad: z.number().int().min(1).optional(),
        fecha: z.union([fechaArg, z.null()]).optional().describe('AAAA-MM-DD, o null para quitarla'),
        esperado: z.object({ prioridad: z.number().int().nullable(), fecha: z.string().nullable() }).optional().describe('Lo que viste en cola_cuadros (obligatorio si cambias prioridad)'),
        confirmar: confirmarArg
    }, (a) => api(token, `/cuadros/${a.cuadro}/prioridad`, { body: { centro: a.centro, prioridad: a.prioridad, fecha: a.fecha, esperado: a.esperado, confirmar: a.confirmar } }));

    t('marcar_comprometida', 'Marca o desmarca un cuadro como Comprometida. Motivo obligatorio: quién lo pidió y por qué (un escalamiento por sí solo no basta). Desmarcar requiere Admin. Vista previa sin `confirmar`.', {
        centro: centroArg, cuadro: z.number().int(), comprometida: z.boolean(), motivo: z.string().min(5), confirmar: confirmarArg
    }, (a) => api(token, `/cuadros/${a.cuadro}/comprometida`, { body: { centro: a.centro, comprometida: a.comprometida, motivo: a.motivo, confirmar: a.confirmar } }));

    return server;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// Bitácora de peticiones (diagnóstico): PLAN_LOG_REQUESTS=1 → una línea por petición, sin el pase.
if (process.env.PLAN_LOG_REQUESTS === '1') {
    app.use((req, res, next) => {
        const t0 = Date.now();
        res.on('finish', () => {
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - t0} ms) ip=${ip} ua="${req.headers['user-agent'] || ''}" origin=${req.headers.origin || '-'} auth=${req.headers.authorization ? 'si' : 'no'}`);
        });
        next();
    });
}

const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id');
};
const unauthorized = (res, msg) => {
    cors(res);
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`);
    res.status(401).json({ error: msg || 'Unauthorized' });
};

// Descubrimiento OAuth (RFC 9728): Claude lo usa para saber dónde iniciar sesión.
const metadata = (req, res) => {
    cors(res);
    if (!AUTH_SERVER) return res.status(503).json({ error: 'PLAN_AUTH_SERVER no configurado' });
    res.json({ resource: RESOURCE, authorization_servers: [AUTH_SERVER], bearer_methods_supported: ['header'], resource_name: 'Ferco Planificación' });
};
app.get('/.well-known/oauth-protected-resource', metadata);
app.get('/.well-known/oauth-protected-resource/mcp', metadata);
app.get('/health', (req, res) => res.json({ ok: true, api: API, resource: RESOURCE }));

// Cache corto de pases ya validados por el app (evita un /yo por cada llamada)
const validos = new Map();
async function validarPase(token) {
    const hit = validos.get(token);
    if (hit && hit > Date.now()) return null;
    try {
        await api(token, '/yo');
        validos.set(token, Date.now() + 60 * 1000);
        if (validos.size > 500) validos.delete(validos.keys().next().value);
        return null;
    } catch (e) { return e; }
}

app.all('/mcp', async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: 'Forbidden origin' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return unauthorized(res);
    const problema = await validarPase(token);
    if (problema) {
        if (problema.status === 401) return unauthorized(res, problema.message);
        if (problema.status === 403) return res.status(403).json({ error: problema.message });
        return res.status(502).json({ error: `No se pudo validar el acceso con el app: ${problema.message}` });
    }

    // Sin estado: un servidor y un transporte por petición (el pase queda ligado a las herramientas)
    const server = buildServer(token);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (e) {
        console.error('MCP:', e.message);
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Error interno' }, id: null });
    }
});

app.listen(PORT, () => {
    console.log(`Ferco Planificación MCP en http://localhost:${PORT}/mcp → API ${API}`);
    if (!AUTH_SERVER) console.warn('AVISO: PLAN_AUTH_SERVER no configurado; el descubrimiento OAuth responderá 503.');
});
