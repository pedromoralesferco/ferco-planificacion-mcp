# Ferco Planificación — conector MCP

Capa delgada entre Claude y el app de Picking. Cada herramienta es una llamada a `/api/planificacion/*` del app con el pase del usuario (Supabase Auth + Microsoft). **No tiene credenciales**: ni base de datos, ni Supabase, ni UiPath. El app valida el pase, aplica permisos y audita.

- Transporte: MCP Streamable HTTP sin estado, en `/mcp`.
- Descubrimiento OAuth (RFC 9728): `/.well-known/oauth-protected-resource/mcp`.
- 18 herramientas: 12 de lectura y 6 de escritura en dos pasos (vista previa + `confirmar`).

## Correr

```
cp .env.example .env   # y ajustar
npm install
npm start              # http://localhost:3002/mcp
```

Variables: `PORT`, `PLAN_API_URL` (app de Picking), `PLAN_PUBLIC_URL` (URL pública de este servicio), `PLAN_AUTH_SERVER` (Supabase Auth `…/auth/v1`), `PLAN_ALLOWED_ORIGINS`.

Despliegue en producción: ver `DEPLOY_PLANIFICACION.md` en el repositorio del app de Picking.
