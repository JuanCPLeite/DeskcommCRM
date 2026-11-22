import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/official/embedded-signup — o que o navegador precisa para
 *      abrir a janela da Meta, e se esta empresa PODE abri-la.
 * POST /api/v1/channels/official/embedded-signup — fecha a conexão com o `code` que
 *      a janela devolveu (#4074).
 *
 * É a SEGUNDA porta do número oficial; a primeira (token colado à mão) continua em
 * `/api/v1/channels/official`. As duas gravam a mesma linha de `channel_sessions`, e
 * a procedência fica registrada (`meta_connection_origin`).
 *
 * ─── O que o GET devolve, e por que isso é público ──────────────────────────
 *
 * `app_id` e `config_id` são identificadores que a Meta EXIGE no navegador
 * (`FB.init`/`FB.login`): não são segredo. O App Secret nunca passa por esta rota
 * — ele só é usado no servidor, dentro de `conectarPeloSignup`.
 *
 * ─── O corpo do POST não é confiança ────────────────────────────────────────
 *
 * `organization_id` vem da sessão (`requireRole`), nunca do corpo. `waba_id` e
 * `phone_number_id` vêm do navegador e só valem depois de o servidor provar, com o
 * token trocado do `code`, que o número é daquela conta.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { acessoDaEmpresa } from "@/lib/channels/meta/acesso-da-empresa";
import { conectarPeloSignup } from "@/lib/channels/meta/conectar-por-signup";
import { MODOS_DO_SIGNUP, extrasDoSignup, type ModoDoSignup } from "@/lib/channels/meta/embedded-signup";
import { contarNumerosAtivos } from "@/lib/channels/meta/numeros-da-empresa";
import { signupDaMeta } from "@/lib/channels/meta/signup-config";
import { graphVersion } from "@/lib/graph-version";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const finalizarSchema = z.object({
  // O `code` vale 5 minutos; o piso e o teto só barram lixo óbvio.
  code: z.string().trim().min(10).max(2000),
  // Opcional: o evento real da Meta pode vir sem `waba_id`; o servidor descobre pelo token.
  waba_id: z
    .string()
    .trim()
    .regex(/^[0-9]{5,30}$/)
    .nullish(),
  phone_number_id: z
    .string()
    .trim()
    .regex(/^[0-9]{5,30}$/)
    .nullish(),
  modo: z.enum(MODOS_DO_SIGNUP as [ModoDoSignup, ...ModoDoSignup[]]),
});

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official_signup" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const [signup, acesso] = await Promise.all([signupDaMeta(), acessoDaEmpresa(orgId)]);

  // Quantos números a empresa já tem — para a tela dizer "2 de 3" em vez de deixar
  // a pessoa descobrir o teto na volta da janela da Meta.
  const ativos = await contarNumerosAtivos(createAdminClient(), orgId);

  // Sem `config_id` a janela da Meta não abre — a tela diz o que falta em vez de
  // oferecer um botão que não funciona.
  const configId = signup.configId;
  const configIdCoexistencia = signup.configIdCoexistencia ?? signup.configId;
  const naoConfigurado = !signup.appId || !configId;

  const modo = (disponivel: boolean, id: string | null, m: ModoDoSignup) => ({
    disponivel: disponivel && !naoConfigurado && id !== null,
    configId: id,
    extras: extrasDoSignup(m),
  });

  const motivo = naoConfigurado
    ? "meta_app_nao_configurado"
    : !acesso.embeddedSignup
      ? "signup_nao_liberado"
      : null;

  return ok({
    disponivel: motivo === null,
    motivo,
    appId: signup.appId,
    graphVersion: graphVersion(),
    modos: {
      numero_novo: modo(acesso.embeddedSignup, configId, "numero_novo"),
      coexistencia: modo(acesso.coexistencia, configIdCoexistencia, "coexistencia"),
    },
    numeros: { ativos, maxNumeros: acesso.maxNumeros },
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official_signup" });
  if (!authz.ok) return authz.response;

  const parsed = finalizarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "code e modo são obrigatórios", 422, { requestId });
  }

  const r = await conectarPeloSignup({
    admin: createAdminClient(),
    organizationId: authz.org.orgId,
    userId: authz.user.id,
    idioma: authz.user.idioma,
    requestId,
    base: basePublicaDoWebhookMeta(req),
    code: parsed.data.code,
    wabaId: parsed.data.waba_id ?? null,
    phoneNumberId: parsed.data.phone_number_id ?? null,
    modo: parsed.data.modo,
  });

  if (!r.ok) {
    return fail(r.code, r.message, r.status, {
      requestId,
      ...(r.details !== undefined ? { details: r.details } : {}),
    });
  }

  // Fire-and-forget, como toda auditoria do repo. Só o QUE aconteceu: nem token,
  // nem `code`, nem PIN.
  void audit({
    action: "channel.official_connected_signup",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: r.channelSessionId,
    requestId,
    metadata: { provider: CHANNEL_PROVIDER_META, modo: r.modo },
  });

  return ok({
    connected: true,
    channelSessionId: r.channelSessionId,
    displayName: r.displayName,
    phoneNumber: r.phoneNumber,
    modo: r.modo,
    origem: r.origem,
    webhookRegistro: r.webhookRegistro
      ? {
          registrado: r.webhookRegistro.registrado,
          url: r.webhookRegistro.url,
          erro: r.webhookRegistro.erro,
          em: r.webhookRegistro.em,
        }
      : null,
    registro: r.registro ? { registrado: r.registro.ok, erro: r.registro.ok ? null : r.registro.motivo } : null,
    sincronizacao: r.sincronizacao
      ? {
          contatos: { pedido: r.sincronizacao.contatos.ok, erro: r.sincronizacao.contatos.ok ? null : r.sincronizacao.contatos.motivo },
          historico: { pedido: r.sincronizacao.historico.ok, erro: r.sincronizacao.historico.ok ? null : r.sincronizacao.historico.motivo },
        }
      : null,
  });
}
