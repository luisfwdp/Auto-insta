# Confirmação de mídia: timeout após upload

## Incidente real em 18/11/2026 (America/Sao_Paulo)

Na main 327511148c4a3978cc7298e17f8d5af7c1b9b214, dois uploads autorizados do mesmo vídeo de teste chegaram ao bucket privado com 75.974 bytes, mas a confirmação PATCH /api/publishing/media não terminou. Os assets continuaram UPLOADING. A Vercel registrou timeout de 300 segundos nos dois requests:

- 23:05:39 → 23:10:39, request 9b6h4-1795053939176-fc02a4e1310f.
- 23:10:15 → 23:15:15, request x94jh-1795054215489-a5269ac7a58d.

O navegador também registrou ERR_NETWORK_CHANGED na primeira tentativa. Isso não explica isoladamente os dois timeouts do servidor. Nenhuma publicação, lote Speed Post ou chamada de publicação Meta foi criada. Não foram apagados dados nem promovidos assets manualmente.

## Reprodução e correção

A inspeção não comercial obtém os primeiros 32 bytes com Range e aguardava reader.cancel(). O createDedupeFetch da versão instalada do Next.js clona a resposta por tee. O cancelamento de uma ramificação pode continuar pendente enquanto outra permanece retida. A própria implementação clone-response do Next documenta que ambas precisam ser canceladas.

A suíte usa o deduplicador real instalado e uma segunda resposta clonada com ramo retido: os dois testes novos falham na main e passam com a correção. Não dependem de Supabase nem de credenciais reais. Isso comprova o bloqueio reproduzido no código, sem substituir a validação do próximo upload real após deploy. A trace interna do request não estava acessível: conector 403 e fallback CLI 404; não se afirma inspeção de spans que não foram obtidos.

A mudança se limita à inspeção não comercial:

- fetch privado sem cache, sem seguir redirecionamentos e com AbortSignal de 15 segundos. O sinal também evita a deduplicação/clonagem do Next.
- Solicitar cancelamento sem aguardar o ramo retido, tratando rejeição da limpeza. O prazo de rede permanece limitado.
- Preservar autenticação, RBAC, workspaceId, bucket privado, Range, tamanho real e validação do conteúdo antes de READY.

O caminho comercial já possui fetch com sinal e não foi alterado. Worker, envio Meta, scheduling, idempotência, schema e limites permanecem intactos.

## Validação e recuperação

Testes de regressão: 2 falham antes, passam depois. Suítes dirigidas de storage/comercial/isolamento: 32 testes. Composição: 1.948 testes em 120 arquivos, zero skips, em PostgreSQL descartável. Typecheck e lint aprovados. Build e CI serão registrados no PR.

Após revisão Claude, merge humano e deploy Vercel aprovado, confirmar o upload pela API/interface autenticada. Não alterar UPLOADING para READY por SQL. Preferir recuperar o asset existente via PATCH se houver cliente autorizado para isso; se a interface exigir nova seleção, registrar o novo asset e selecionar somente um para a publicação. Não repetir publish diante de resultado Meta desconhecido.

Rollback: reverter este PR e republicar a main aprovada anterior. Nenhuma migração, remoção de dados, troca de segredo ou atualização Fly é exigida por esta correção de confirmação web. Os dois vídeos continuam autorizados, mas o teste real de agendamento e Speed Post permanece pendente até a confirmação de mídia funcionar em produção.
