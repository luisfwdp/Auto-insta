# Auditoria UX — 2026-10-29

Esta rodada é parcial. Separar inspeção de código de verificação visual.
Base e583a6f. Não foram acessados banco, credenciais ou Meta reais.

| Área | Evidência desta rodada | Pendência |
| --- | --- | --- |
| Sidebar/topbar | Presentes nas capturas de listagem/wizard/detalhes | Foco do menu mobile e revisão manual completa |
| Dashboard | Contrato e componente inspecionados | Nova captura dos estados completos |
| Contas | Contrato stats inspecionado; melhoria em PR independente | OAuth e conexão real |
| Campanhas | Playwright/axe on; comparação visual off com main, 3 tamanhos | Sessão/banco reais |
| Wizard | Três etapas, teclado, erros, edição, confirmação e mobile passaram | Jornada real de homologação |
| Detalhes | Nova interface em PR; 12 combinações de estado/tamanho | Revisão cruzada e integração |
| Relatório público | Rota existente identificada | Auditoria visual completa |
| Configurações | Código inspecionado | Capturas e fluxo real |
| Login/acesso | 401 no novo detalhe exercitado com fixture | Login e permissões reais |

## Defeitos encontrados no código

1. Detalhe legado trata falha de API como campanha ausente. Interface nova distingue
   erro, 401 e ausência confirmada; legado preservado por exigência da sprint.
2. Toggle legado muda isActive sem validar resposta HTTP/success.
   Interface nova é somente leitura e usa edição/listagem existente; o bug no
   caminho legado permanece pendente de correção autorizada e testes específicos.
3. Configurações não recupera rejection do Promise.all de carregamento.
   Pode mostrar estados derivados de dados ausentes; pendente, sem alteração nesta entrega.
4. Topbar oferece conectar mesmo sem conhecer a configuração Meta.
   A rota real informa misconfigured; onboarding proposto explicita essa dependência.

Não atribuir esses defeitos a observação visual: foram encontrados por inspeção.
Não foram encontrados bugs adicionais no wizard durante os testes executados;
nenhum teste foi removido ou relaxado para obter esse resultado.

Screenshots históricas da main continuam em screenshots/, ui-screenshots/ e
campaign-screenshots/. Não são apresentadas como capturas novas desta sprint.
Novas capturas de detalhes/onboarding são entregues em seus PRs independentes,
com identificação expressa de fixtures.
