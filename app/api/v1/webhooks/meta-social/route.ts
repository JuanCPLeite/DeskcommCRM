/**
 * GET|POST /api/v1/webhooks/meta-social — webhook da Meta para Instagram (conexão direta).
 *
 * A Meta cadastra UMA URL por app, então esta rota não tem token de sessão no
 * caminho (o do WhatsApp oficial tem). A organização vem da CONTA que recebeu
 * (`entry[].id` → `channel_sessions.social_account_id`, única), resolvida no banco
 * DEPOIS de a assinatura conferir — nada que o corpo diga sobre tenant é usado.
 *
 * `GET` é o handshake: devolve `hub.challenge` em texto puro (envelopar em
 * `{data:...}` faz a verificação da Meta falhar). `POST` verifica HMAC SHA-256 com
 * a chave do app ANTES de qualquer escrita.
 *
 * Conta que ninguém conectou, comentário e campo sem tratamento respondem 200:
 * erro faria a Meta reentregar em backoff um evento que nunca vai melhorar. Já a
 * falha real de ingestão responde 500, para ela reentregar — a idempotência por
 * `external_id` do núcleo torna a reentrega inofensiva.
 */
import { NextResponse, type NextRequest } from "next/server";

import { comIdDaRequisicao, fail } from "@/lib/api/wrappers";

import { abrirArquivoDoWebhook, fecharArquivoDoWebhook } from "@/lib/channels/arquivo-de-webhook";
import { verificationChallenge, verifyMetaSignature } from "@/lib/channels/meta/webhook";
import { appSocialDaMeta } from "@/lib/channels/meta-social/app";
import { ingestMetaSocial, sessaoDaConta } from "@/lib/channels/meta-social/ingest";
import { parseMetaSocialWebhook } from "@/lib/channels/meta-social/webhook";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { verifyToken } = await appSocialDaMeta();
  const challenge = verificationChallenge(req.nextUrl.searchParams, verifyToken ?? "");
  if (challenge === null) return fail("forbidden", "Verificação recusada.", 403);
  return comIdDaRequisicao(new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }), req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const { appSecret } = await appSocialDaMeta();
  // Fail-closed: sem a chave do app não há como provar a origem.
  if (!verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"), appSecret ?? "")) {
    return fail("invalid_signature", "Assinatura inválida.", 401);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return fail("invalid_json", "Corpo inválido.", 400);
  }

  const eventos = parseMetaSocialWebhook(json);
  const admin = createAdminClient();

  // Agrupa por conta: cada conta conectada arquiva o corpo cru UMA vez, na sua organização.
  const porConta = new Map<string, typeof eventos>();
  for (const e of eventos) porConta.set(e.contaId, [...(porConta.get(e.contaId) ?? []), e]);

  let falhou = false;
  for (const [contaId, doConta] of porConta) {
    let sessao: { id: string; organizationId: string } | null = null;
    try {
      sessao = await sessaoDaConta(admin, contaId);
    } catch (err) {
      logger.error("[meta-social.webhook] falha ao resolver a conta", { conta: contaId, erro: err instanceof Error ? err.message : String(err) });
      falhou = true;
      continue;
    }
    // Conta que nenhuma organização conectou: nada a gravar, e 200 para a Meta não reentregar.
    if (!sessao) continue;

    const arquivo = await abrirArquivoDoWebhook(admin, {
      organizationId: sessao.organizationId,
      channelSessionId: sessao.id,
      provider: "meta_social",
      rawBody,
      headers: req.headers,
    });
    try {
      for (const evento of doConta) await ingestMetaSocial(admin, evento, sessao);
      await fecharArquivoDoWebhook(admin, arquivo, { status: "processed", validSignature: true });
    } catch (err) {
      // A mensagem do erro fica no arquivo (só o operador lê) e no log; a resposta não a repete.
      const motivo = err instanceof Error ? err.message : String(err);
      logger.error("[meta-social.webhook] ingestão falhou", { conta: contaId, erro: motivo });
      await fecharArquivoDoWebhook(admin, arquivo, { status: "error", validSignature: true, erro: motivo.slice(0, 500) });
      falhou = true;
    }
  }

  if (falhou) return fail("ingest_failed", "Falha ao processar a entrega.", 500);
  return comIdDaRequisicao(NextResponse.json({ received: true }, { status: 200 }), req);
}
