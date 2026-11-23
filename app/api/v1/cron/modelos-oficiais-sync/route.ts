/**
 * modelos-oficiais-sync — refaz o espelho dos modelos de cada conta oficial.
 *
 * O webhook já refaz o espelho em segundos quando a Meta avisa. Este cron é a rede de
 * segurança de hora em hora: cobre o evento que não chegou (webhook fora do ar, conta
 * com callback de outro sistema) e o modelo apagado na Meta. Só consulta a Graph API;
 * não envia nada a ninguém.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET (fail-closed), como os demais.
 * O agendamento vive no serviço `scheduler` (docker/scheduler/entrypoint.sh).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { ressincronizarTodasAsWabas } from "@/lib/channels/meta/ressincronizar-modelos";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const admin = createAdminClient();
  const paradas = new Set(await idsDeOrgsParadas(admin));
  const resumo = await ressincronizarTodasAsWabas(admin, paradas);
  return ok(resumo, { requestId });
}

export const GET = handle;
export const POST = handle;
