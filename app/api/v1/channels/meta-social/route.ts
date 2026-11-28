/**
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
