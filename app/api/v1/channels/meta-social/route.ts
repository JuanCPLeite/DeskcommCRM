/**
 * GET  /api/v1/channels/meta-social — as contas Instagram conectadas da organização, a saúde
 *       de cada uma e se o app Meta da instalação está configurado (nunca devolve token).
 * POST /api/v1/channels/meta-social — conectar contas Instagram pelo login unificado.
 *
 *   { acao: "iniciar" }                     → { url } do diálogo de consentimento da Meta;
 *   { acao: "concluir", estado, code }      → as contas conectadas, entregue pela tela
 *                                             depois da ponte de `/auth/meta-social-return`.
 *
 * Não sabe com quem fala: o fluxo inteiro mora em `lib/channels/meta-social/conectar.ts`.
 * Aqui ficam só as guardas — papel de admin, suporte temporário só-leitura,
 * verificação em duas etapas, limite de tentativas — e a auditoria (sem o token
 * nem o código de autorização).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { appSocialDaMeta } from "@/lib/channels/meta-social/app";
import { ErroDaConexaoMeta, concluirConexaoMeta, iniciarConexaoMeta } from "@/lib/channels/meta-social/conectar";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaConfiguradaDaInstalacao } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

const corpoSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("iniciar") }).strict(),
  z
    .object({
      acao: z.literal("concluir"),
      estado: z.string().min(20).max(700),
      code: z
        .string()
        .min(10)
        .max(2048)
        .regex(/^[A-Za-z0-9_\-.~]+$/),
    })
    .strict(),
]);

/** Cada código da conexão vira um status HTTP e uma frase para a tela. */
const STATUS_DO_ERRO: Record<ErroDaConexaoMeta["codigo"], number> = {
  app_nao_configurado: 422,
  estado_invalido: 400,
  estado_de_outra_sessao: 403,
  sem_conta_atribuida: 422,
  troca_do_codigo_falhou: 400,
  cifra_indisponivel: 422,
};

interface LinhaDaConta {
  id: string;
  display_name: string | null;
  social_account_id: string | null;
  status: string | null;
  meta_social_token_expires_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export async function GET(_req?: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_meta_social" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  // Colunas EXPLÍCITAS: o token cifrado nunca entra na seleção.
  const { data, error } = await createAdminClient()
    .from("channel_sessions")
    .select("id, display_name, social_account_id, status, meta_social_token_expires_at, metadata, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "meta_social")
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    logger.warn("[channels.meta-social] não deu para listar as contas", { organization_id: authz.org.orgId, codigo: error.code });
    return fail("internal_error", t("Não foi possível carregar as contas do Instagram."), 500, { requestId, headers });
  }

  const app = await appSocialDaMeta();
  const faltam = (["appId", "loginConfigId", "appSecret"] as const).filter((c) => !app[c]);

  const agora = Date.now();
  const contas = ((data ?? []) as LinhaDaConta[]).map((c) => {
    const vencido = c.meta_social_token_expires_at !== null && new Date(c.meta_social_token_expires_at).getTime() <= agora;
    return {
      channel_id: c.id,
      ig_id: c.social_account_id,
      username: (c.display_name ?? "").replace(/^instagram\s*·\s*/i, ""),
      status: c.status,
      health: vencido ? "token_vencido" : c.status === "WORKING" ? "ok" : "atencao",
      token_expires_at: c.meta_social_token_expires_at,
      webhook_assinado: c.metadata?.meta_social_webhook_assinado === true,
      connected_at: c.created_at,
    };
  });

  return ok(
    {
      configured: faltam.length === 0,
      faltam,
      // Quem administra a PLATAFORMA configura o app; o admin da empresa só vê o aviso.
      configurar_em: authz.user.is_platform_admin ? "/admin/meta-social" : null,
      accounts: contas,
    },
    { requestId, headers },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_meta_social" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  if (await mfaEmDivida()) {
    return fail("mfa_required", t("Confirme a verificação em duas etapas."), 403, { requestId, headers });
  }
  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Confira os dados da conexão."), 400, { requestId, headers });
  }
  const orgId = authz.org.orgId;
  const limite = await checkRateLimit(`meta-social-conectar:${orgId}`, 20, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Aguarde um minuto antes de tentar novamente."), 429, {
      requestId,
      headers: { ...headers, "Retry-After": "60" },
    });
  }

  // O endereço da volta vem só da configuração da instalação, nunca de quem fez o pedido.
  const publicBase = basePublicaConfiguradaDaInstalacao({ aceitarMaquinaLocal: false });
  if (!publicBase) {
    return fail(
      "base_publica_nao_configurada",
      t("O endereço público desta instalação não está configurado. Quem administra a instalação precisa definir NEXT_PUBLIC_APP_URL com o endereço pelo qual ela é acessada."),
      503,
      { requestId, headers },
    );
  }

  const ctx = {
    organizationId: orgId,
    userId: authz.user.id,
    segredo: env.INTERNAL_SECRET,
    agora: new Date(),
    publicBase,
  };
  const corpo = parsed.data;

  try {
    if (corpo.acao === "iniciar") {
      const { url } = await iniciarConexaoMeta(ctx);
      return ok({ url }, { requestId, headers });
    }
    const r = await concluirConexaoMeta(createAdminClient(), ctx, { estado: corpo.estado, code: corpo.code });
    for (const conta of r.conectadas) {
      void audit({
        action: "channel.connected",
        actorUserId: ctx.userId,
        organizationId: ctx.organizationId,
        resourceType: "channel_session",
        resourceId: conta.channelId,
        requestId,
        // O QUE aconteceu, nunca o token nem o código de autorização.
        metadata: { canal: "meta_social", modo: "login_unificado", webhook: conta.webhookAssinado ? "assinado" : "falhou" },
      });
    }
    return ok(
      {
        conectadas: r.conectadas.map((c) => ({
          channel_id: c.channelId,
          ig_id: c.igId,
          username: c.username,
          webhook_assinado: c.webhookAssinado,
        })),
        recusadas: r.recusadas.map((c) => ({ ig_id: c.igId, motivo: c.motivo })),
      },
      { requestId, headers },
    );
  } catch (erro) {
    if (erro instanceof ErroDaConexaoMeta) {
      return fail(erro.codigo, t(erro.message), STATUS_DO_ERRO[erro.codigo], {
        requestId,
        headers,
        details: erro.faltam.length ? { faltam: erro.faltam } : undefined,
      });
    }
    const limiteDoPlano = traduzirLimiteDoPlano(erro, authz.user.idioma);
    if (limiteDoPlano) {
      return fail(limiteDoPlano.code, limiteDoPlano.message, 409, { requestId, headers, details: limiteDoPlano.details });
    }
    logger.warn("[channels.meta-social] conexão não concluída", {
      organization_id: orgId,
      acao: corpo.acao,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return fail("upstream_unavailable", t("Não foi possível concluir a conexão. Tente novamente."), 502, { requestId, headers });
  }
}
