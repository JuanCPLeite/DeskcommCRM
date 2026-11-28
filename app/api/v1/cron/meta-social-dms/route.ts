/**
 * meta-social-dms — a busca de DMs do Instagram pela API (a rede de segurança do webhook).
 *
 * A Meta entrega o aviso de comentário, mas nem sempre o de DM; a API de conversas, porém,
 * sempre enxerga a mensagem. Este cron pergunta a cada minuto e entrega o que for novo ao
 * mesmo caminho do webhook (`lib/channels/meta-social/busca.ts`). A idempotência é a do núcleo
 * (`external_id` único): se o aviso voltar a chegar, a mensagem não duplica.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET (fail-closed), como os demais.
 * NOTA DE DEPLOY: o agendamento vive em `docker/scheduler/entrypoint.sh`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { buscarDmsNovas } from "@/lib/channels/meta-social/busca";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  // A chave de liga/desliga: `META_SOCIAL_BUSCA=off` no `.env` para a busca. Serve para provar o webhook
  // sozinho (com a busca ligada, não dá para saber quem entregou a DM) e para desligar a rede de
  // segurança quando o webhook estiver comprovado. Qualquer outro valor deixa ligada.
  if ((process.env.META_SOCIAL_BUSCA ?? "").trim().toLowerCase() === "off") {
    return ok({ pulado: "busca_desligada" }, { requestId });
  }
  try {
    const r = await buscarDmsNovas(createAdminClient());
    if (r.falhas > 0) logger.warn("[meta-social.busca] contas com falha na rodada", { ...r });
    return ok(r, { requestId });
  } catch (err) {
    logger.error("[meta-social.busca] rodada falhou", { erro: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", "A busca de DMs falhou.", 500, { requestId });
  }
}

export const GET = handle;
export const POST = handle;
