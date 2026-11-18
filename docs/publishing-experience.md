# Upload, onboarding e calendário — F9

Refinamento visual solicitado pelo proprietário a partir das referências do
21st.dev. Implementação própria com React/CSS Modules existentes, sem novas
dependências, serviços, alterações de API, worker, banco ou autenticação.

- Upload: botão acessível por teclado e dropzone; até 100 arquivos por seleção,
  prévias locais e estados aguardando/envio/verificação/pronto/falha por arquivo.
  A contagem avança somente depois do PATCH de confirmação. Uma falha não apaga
  os arquivos concluídos; não há retry automático de POST/PUT/PATCH. O contrato
  de URL assinada e x-upsert=false permanece. Speed Post aceita vídeos MP4/MOV;
  Programação mantém JPEG/MP4/MOV. Validações do servidor continuam obrigatórias.
- Onboarding: três etapas com progresso obtido das contas, automações e DMs SENT
  do workspace atual. Não trata webhookSubscribed como prova de envio ou
  recebimento. A seleção de outra conta não transforma métricas do workspace em
  métricas por conta. Falha de carregamento oculta o progresso.
- Calendário: largura completa, dias da semana, Hoje, mês anterior/próximo,
  status traduzido e link para os controles existentes no histórico. Em telas
  até 640px, exibe agenda cronológica. Agrupamento e edição mantêm o fuso local
  do navegador, agora explícito. Não há alteração na execução dos agendamentos.
- Transições CSS de 180ms e preferência por movimento reduzido respeitada.
  Cores preto/grafite/verde-limão e foco visível preservados.

Referências de apresentação (não são dependências nem serviços de runtime):

- https://21st.dev/@utilcn/components/upload-multiple-files
- https://21st.dev/@shadcnspace/components/progress-02
- https://21st.dev/@ahmedmayara/components/fullscreen-calendar

Validação: typecheck, lint, suíte Vitest com PostgreSQL descartável e build.
Navegador desktop/mobile usa uma cópia isolada das telas e APIs fictícias;
prova interação, estados, contratos emitidos e acessibilidade, sem comprovar
armazenamento externo, entrega Meta ou publicação real. Screenshots e resumo
das verificações acompanham o PR. Nenhum conteúdo real é publicado no teste.

Rollback: reverter este commit de interface. Não exige migração, alteração de
credenciais, limpeza de dados ou mudança de versão do worker. Merge e deploy
não fazem parte deste PR de revisão.

## Evidências de revisão

- 1.945 testes /120 suítes, sem skips, com PostgreSQL descartável.
- Typecheck, lint e build passaram; lint tem somente o aviso anterior em invitation-accept-card.
- [53 verificações de navegador](criaping/publishing-experience/checks.json),
  incluindo lote de 100 arquivos, teclado, drop válido/ocupado/inválido, confirmação,
  falha parcial, limites, progresso honesto, fuso, edição e cancelamento.
- Seis auditorias axe WCAG A/AA nos componentes dentro de main: zero violações.
- [Upload desktop](criaping/publishing-experience/speed-upload-desktop.png)
  e [mobile](criaping/publishing-experience/speed-upload-mobile.png).
- [Onboarding desktop](criaping/publishing-experience/onboarding-desktop.png)
  e [mobile](criaping/publishing-experience/onboarding-mobile.png).
- [Calendário desktop](criaping/publishing-experience/calendar-desktop.png)
  e [mobile](criaping/publishing-experience/calendar-mobile.png).

Graphify local: 485 fontes, 3.169 nós/8.474 arestas, sem LLM; confirmou os dois
consumidores do uploader e o mesmo publishingRequest. SQL não foi mapeado por
falta do parser opcional; não há SQL alterado. O arquivo criaping-tokens.css foi
ignorado pela heurística do extrator, mas sua identidade foi preservada no diff.
