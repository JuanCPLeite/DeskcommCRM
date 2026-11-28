import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * O entrypoint do agendador escreve a tabela de crons por um heredoc SEM aspas, para expandir
 * variáveis. Consequência: crase ou `$(` num COMENTÁRIO dessa tabela é executado como comando.
 * Foi assim que uma frase com `messages` entre crases deixou o agendador em loop (código 127) e
 * parou todos os crons da instalação até o rollback.
 */
describe("docker/scheduler/entrypoint.sh", () => {
  it("a tabela de crons não tem crase nem substituição de comando", () => {
    const linhas = readFileSync(join(__dirname, "..", "..", "docker", "scheduler", "entrypoint.sh"), "utf8").split("\n");
    // Só a string `CRONS="..."` é executada pelo shell; os comentários fora dela são inofensivos.
    const abre = linhas.findIndex((l) => l.startsWith('CRONS="'));
    expect(abre, "CONTROLE: a string CRONS foi achada").toBeGreaterThanOrEqual(0);
    const fecha = linhas.findIndex((l, i) => i > abre && l === '"');
    expect(fecha, "CONTROLE: o fim da string foi achado").toBeGreaterThan(abre);
    const ruins = linhas
      .slice(abre, fecha)
      .map((l, i) => ({ n: abre + i + 1, l }))
      .filter(({ l }) => l.includes("`") || l.includes("$("));
    expect(ruins).toEqual([]);
  });
});
