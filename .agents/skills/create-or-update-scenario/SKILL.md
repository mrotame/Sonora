---
name: create-or-update-scenario

description: >-
  Create, implement, review, refactor, or update visual scenarios for the
  Sonora project. Use this skill whenever a task involves defining a new
  scenario, changing an existing scenario's visual identity, composition,
  procedural generation, musical interpretation, feature-to-visual mappings,
  or scenario-specific behavior. Ensures compliance with Sonora's shared
  architecture, deterministic generation, musical synchronization, and
  technology stack.

argument-hint: "[operation] [scenario_id] [scenario_name] [scenario_description]"

disable-model-invocation: false
user-invocable: true

---

## Parameters

The skill accepts the following parameters. All parameters must be recognized,
including optional parameters. When a parameter is not provided, use its
documented default behavior. Ask the user for clarification only when the
missing information is necessary to proceed reliably.

### 1. operation

- **Required:** Yes
- **Type:** string
- **Allowed values:**
  - `create`: Create a new scenario.
  - `update`: Modify an existing scenario.
  - `review`: Review an existing scenario and identify inconsistencies,
    architectural violations, or improvement opportunities.
  - `refactor`: Restructure an existing scenario without necessarily changing
    its visual identity or intended behavior.
- **Default:** None.
- **Behavior:** Determines the main workflow executed by the skill.

### 3. scenario_name

- **Required:** No
- **Type:** string
- **Allowed values:** Any descriptive human-readable name.
- **Examples:** `Voxel Dreamscape`, `Cybernetic Cosmos`.
- **Default:** Derive from `scenario_id` or ask the user if the intended
  identity is unclear.
- **Behavior:** Defines the display name of the scenario.

### 4. scenario_description

- **Required:** Conditional
- **Type:** string
- **Allowed values:** Free-form natural language.
- **Default:** None.
- **Behavior:** Describes the intended visual identity, atmosphere,
  environment, and experience. Required for `create` unless the user has
  already established these details in the conversation.

### 5. visual_references

- **Required:** No
- **Type:** array of strings
- **Allowed values:** Image paths, URLs, descriptions, or references to
  previously supplied visual material.
- **Default:** Empty array.
- **Behavior:** Provides visual guidance for the scenario's appearance.
  References are inspirational constraints, not permission to disregard
  Sonora's architecture or technical limitations.

### 6. musical_mapping_strategy

- **Required:** No
- **Type:** string
- **Allowed values:**
  - `scenario_defined`: The scenario defines its own feature-to-visual mappings.
  - `user_guided`: The user provides or approves the main mappings.
  - `hybrid`: The skill proposes mappings and asks the user to validate
    important decisions.
- **Default:** `hybrid`.
- **Behavior:** Determines how musical features are associated with visual
  properties. It must never impose universal mappings across all scenarios.

### 7. visual_complexity

- **Required:** No
- **Type:** string
- **Allowed values:**
  - `low`: Simple geometry, limited effects, and restrained visual variation.
  - `medium`: Balanced geometry, environmental detail, and visual effects.
  - `high`: Complex procedural structures, richer effects, and greater
    environmental variation.
  - `very_high`: Maximum intended visual complexity, subject to performance
    constraints.
- **Default:** `medium`.
- **Behavior:** Establishes the intended visual complexity and guides
  implementation and performance decisions. It does not override runtime
  performance requirements.

### 8. implementation_scope

- **Required:** No
- **Type:** string
- **Allowed values:**
  - `documentation`: Define or update the scenario specification only.
  - `prototype`: Produce an initial functional implementation.
  - `full`: Implement the complete scenario within the existing architecture.
  - `incremental`: Implement only the explicitly requested portion.
- **Default:** `full`.
- **Behavior:** Defines how much implementation work should be performed.

### 9. additional_constraints

- **Required:** No
- **Type:** array of strings
- **Allowed values:** Free-form natural-language constraints.
- **Default:** Empty array.
- **Behavior:** Contains additional requirements, restrictions, preferences,
  or implementation details that are not represented by other parameters.
  These constraints cannot override the fixed rules of Sonora's architecture.
---

# Sonora Scenario Creator

## 1. Objetivo da Skill

Esta skill orienta a criação, implementação, revisão e atualização de cenários visuais do projeto Sonora.

O objetivo é permitir que a IA desenvolva cenários 3D proceduralmente gerados e sincronizados com música, respeitando a arquitetura compartilhada do Sonora.

A skill deve garantir que:

- Todos os cenários respeitem as mesmas regras fundamentais do Sonora.
- Cada cenário tenha liberdade para desenvolver sua própria identidade visual.
- Cada cenário possa escolher como interpretar as informações musicais disponíveis.
- A análise musical não seja duplicada ou implementada dentro dos cenários.
- A geração procedural seja determinística.
- A implementação seja modular, reutilizável e compatível com a arquitetura existente.
- Novos cenários possam ser criados sem modificar desnecessariamente os sistemas compartilhados.

A IA deve utilizar esta skill tanto para criar um cenário do zero quanto para atualizar um cenário existente.

---

## 2. Parâmetros de entrada

A IA deve identificar a intenção da solicitação e utilizar os parâmetros abaixo.

Os parâmetros podem ser informados diretamente pelo usuário, identificados nos arquivos do projeto ou definidos durante a conversa.

Não pergunte novamente informações que já estejam disponíveis.

### 2.1 Parâmetros principais

- `operation`
  - `create`: criar um cenário novo.
  - `update`: atualizar um cenário existente.
  - `review`: revisar um cenário sem necessariamente modificar sua implementação.
  - `refactor`: reorganizar a implementação de um cenário preservando seu comportamento.

- `scenario_id`
  - Identificador estável do cenário.
  - Obrigatório para `update`, `review` e `refactor`.
  - Para `create`, deve ser proposto caso não seja informado.

- `scenario_name`
  - Nome de apresentação do cenário.
  - Pode ser proposto pela IA quando não informado.

- `scenario_description`
  - Descrição geral da experiência visual desejada.
  - Pode ser fornecida por texto, referências visuais ou ambos.

- `visual_references`
  - Imagens, conceitos artísticos, descrições ou referências que definam a direção visual.
  - Opcional.
  - Se não houver referências, a IA pode propor uma direção visual com base na descrição do usuário.

- `musical_mapping_strategy`
  - Estratégia de interpretação musical.
  - Pode ser definida livremente pelo cenário.
  - Não deve existir um mapeamento universal obrigatório entre features musicais e propriedades visuais.

- `visual_complexity`
  - Nível de complexidade visual desejado.
  - Opções sugeridas:
    - `low`
    - `medium`
    - `high`
    - `adaptive`
  - Se não informado, propor um nível compatível com a identidade visual e o orçamento de desempenho.

- `implementation_scope`
  - `visual_design`: definir identidade e comportamento visual.
  - `scenario_architecture`: definir estrutura e contratos do cenário.
  - `implementation`: implementar o cenário.
  - `full`: realizar o processo completo.

- `additional_constraints`
  - Restrições específicas fornecidas pelo usuário.

### 2.2 Comportamento quando faltarem parâmetros

A IA deve seguir estas regras:

1. Consultar primeiro o contexto da conversa e os arquivos do projeto.
2. Preencher automaticamente informações que já estejam documentadas.
3. Propor valores razoáveis quando a escolha não for crítica.
4. Perguntar ao usuário quando uma decisão ausente alterar significativamente a identidade, o comportamento ou o escopo do cenário.
5. Não perguntar sobre regras globais que já estejam definidas nesta skill.
6. Não exigir que o usuário defina individualmente todos os mapeamentos musicais.
7. Apresentar propostas identificadas como propostas, nunca como decisões já aprovadas.

Quando houver várias decisões independentes pendentes, agrupar as perguntas em uma única etapa objetiva.

---

# 3. Regras fixas para todos os cenários

Esta seção contém as regras globais do Sonora.

A IA deve respeitar estas regras ao criar, modificar ou revisar qualquer cenário.

Nenhum cenário pode redefinir unilateralmente essas responsabilidades.

## 3.1 Separação entre análise musical e interpretação visual

A análise musical é compartilhada por todos os cenários.

O sistema central do Sonora é responsável por:

- Processar o áudio.
- Extrair informações do sinal.
- Identificar características rítmicas.
- Estimar informações estruturais e interpretativas.
- Construir uma representação temporal da música.
- Disponibilizar as informações para os cenários.

O cenário é responsável por interpretar essas informações e transformá-las em parâmetros visuais.

Fluxo conceitual obrigatório:

Music Analysis Engine
    |
    v
Musical Timeline
    |
    v
Scenario Interpretation
    |
    v
Scenario Visual Parameters
    |
    v
World Generation / Visual Systems
    |
    v
Rendering

Um cenário não deve:

- Implementar seu próprio pipeline de análise de áudio.
- Duplicar o cálculo de BPM, RMS, espectro ou transientes.
- Criar uma interpretação musical global que deveria pertencer ao Music Intelligence Engine.
- Fazer o renderer interpretar diretamente o áudio bruto.
- Tornar o sistema de análise dependente de um cenário específico.

O cenário pode solicitar novas informações musicais quando houver uma necessidade real, mas deve propor a extensão ao sistema compartilhado em vez de criar uma implementação isolada.

## 3.2 Catálogo compartilhado de informações musicais

Todos os cenários devem consumir as informações disponibilizadas pelo sistema central.

As informações musicais estão organizadas em três categorias.

### A. Informações reativas

Incluem:

- Amplitude e volume.
- RMS e energia do sinal.
- Espectro e características espectrais.
- Energia de bandas de frequência.
- Transientes e impactos.

### B. Informações rítmicas

Incluem:

- BPM estimado.
- Posições das batidas.
- Compassos, quando inferíveis.
- Subdivisões rítmicas, quando inferíveis.
- Padrões e impactos rítmicos.

### C. Informações interpretativas

Incluem estimativas de:

- Seções e mudanças estruturais.
- Introduções, quando detectáveis.
- Transições.
- Pausas.
- Clímax e aumentos significativos de intensidade.
- Tensão e calmaria.
- Contrastes e mudanças inesperadas.

A disponibilidade e confiabilidade de cada informação devem ser consideradas.

Uma estimativa musical não deve ser tratada como verdade absoluta.

O cenário deve tolerar informações ausentes, imprecisas ou com baixa confiança.

### Regra fundamental

A existência de uma informação musical não significa que ela precise ser utilizada por todos os cenários.

Cada cenário escolhe quais informações fazem sentido para sua própria identidade.

## 3.3 Catálogo compartilhado de capacidades visuais

O Sonora deve oferecer sistemas visuais que possam ser utilizados pelos cenários.

Entre as categorias possíveis estão:

- Geometry: geometria, dimensões, formas e deformações.
- Architecture: construções, estruturas e composição espacial.
- Materials: materiais, superfícies e propriedades visuais.
- Colors: paletas, cores e variações cromáticas.
- Lighting: iluminação, intensidade, cor e distribuição.
- Particles: partículas, emissão, movimento e comportamento.
- Atmosphere: neblina, ambiente, profundidade e efeitos atmosféricos.
- Environment: terreno, céu, horizonte e elementos ambientais.
- Motion: movimento, oscilação e transformações.
- Effects: efeitos visuais e pós-processamento.

Essa lista é um catálogo conceitual de capacidades, não uma exigência de que todos os sistemas já estejam implementados.

A IA deve consultar a arquitetura e o código existentes antes de assumir que uma capacidade está disponível.

Se o cenário precisar de uma nova capacidade visual:

1. Identificar a necessidade.
2. Verificar se existe um sistema compartilhado que possa atendê-la.
3. Reutilizar o sistema existente quando adequado.
4. Se não existir, propor a criação de uma capacidade compartilhada ou de uma implementação específica do cenário.
5. Explicar a decisão e evitar duplicação desnecessária.

O catálogo visual deve ser extensível.

## 3.4 Ausência de mapeamentos musicais universais

Não existem relações visuais obrigatórias entre uma feature musical e uma propriedade visual.

Exemplos de relações que NÃO devem ser consideradas regras globais:

- Graves sempre controlam iluminação.
- RMS sempre controla tamanho da geometria.
- BPM sempre controla velocidade.
- Transientes sempre geram partículas.
- Clímax sempre aumenta o brilho.
- Frequências altas sempre controlam cores.

Essas relações podem fazer sentido em determinado cenário, mas não são obrigatórias.

Cada cenário define sua própria gramática visual.

## 3.5 Determinismo

Todos os cenários devem respeitar o sistema de identidade e geração determinística do Sonora.

A identidade do mundo considera:

- Hash SHA-256 do PCM canônico.
- Identificador do cenário.
- Versão do cenário.
- Versão da geração do mundo.

O cenário deve participar dessa identidade por meio de seu identificador e versão.

A geração procedural deve utilizar entradas estáveis e aleatoriedade controlada por seed.

Não utilizar aleatoriedade não determinística para decisões que alterem a identidade do mundo.

Quando houver elementos aleatórios, utilizar uma fonte pseudoaleatória baseada em seed.

A geração de segmentos e subsistemas deve ser reproduzível.

Não depender de:

- FPS.
- Ordem incidental de execução.
- Histórico de frames.
- Estado global aleatório.
- Momento em que um segmento foi carregado.

## 3.6 Reconstrução temporal

O estado visual do mundo deve ser reconstruível em qualquer timestamp.

Para um mesmo conjunto de entradas e um mesmo instante `t`, o cenário deve produzir o mesmo resultado.

Sempre que possível, animações, partículas e transformações devem ser calculadas a partir de:

- Tempo absoluto da música.
- Seed determinística.
- Informações da timeline.
- Configuração do cenário.

Não depender exclusivamente da acumulação de alterações frame a frame.

O cenário não deve impedir que o mundo seja reconstruído em um timestamp arbitrário.

## 3.7 Pré-análise e análise em tempo real

O Sonora combina:

- Pré-análise da faixa completa.
- Análise complementar durante a reprodução.

Decisões importantes de geometria e estrutura do mundo devem utilizar informações determinísticas estabelecidas durante a pré-análise e geração.

A análise em tempo real pode complementar o comportamento visual com variações menores e responsivas.

Não permitir que pequenas variações de processamento em tempo real reorganizem imprevisivelmente a geometria principal do cenário.

## 3.8 Estrutura procedural segmentada

O mundo é dividido em segmentos procedurais.

Todos os cenários devem respeitar o sistema compartilhado de segmentos:

- Cada segmento possui posição estável.
- Cada segmento possui identidade e seed determinísticas.
- Segmentos à frente da câmera são preparados antecipadamente.
- Segmentos suficientemente distantes atrás da câmera podem ser descartados.
- Um segmento recriado deve preservar o mesmo resultado para as mesmas entradas.

O cenário pode definir como seus segmentos são compostos, mas não deve criar um sistema de streaming independente sem necessidade e justificativa arquitetural.

## 3.9 Câmera e experiência

A câmera é compartilhada pela experiência do Sonora.

Regras fixas do MVP:

- A câmera representa a perspectiva do usuário.
- A câmera avança continuamente em linha reta.
- A direção de deslocamento é independente da direção do olhar.
- O usuário pode olhar horizontalmente até 45 graus para cada lado.
- O usuário pode olhar verticalmente até 45 graus para cima ou para baixo.
- Os limites horizontal e vertical são independentes.
- O cenário não deve transformar a câmera em um personagem controlável.
- Elementos como veículos, criaturas ou personagens podem existir, mas são secundários.

O cenário pode influenciar a composição visual ao redor da câmera, mas não deve alterar essas regras.

## 3.10 Responsabilidade do renderer

O renderer deve receber parâmetros e estados visuais resolvidos.

Ele não deve ser responsável por:

- Interpretar o significado musical.
- Definir prioridades de features.
- Escolher mapeamentos específicos do cenário.
- Criar decisões procedurais não determinísticas.

O renderer deve se concentrar na representação visual dos dados recebidos.

## 3.11 Stack tecnológica fixa

A implementação dos cenários deve respeitar a stack aprovada:

- TypeScript.
- React.
- Vite.
- npm.
- Three.js.
- WebGL 2.
- GLSL ES 3.00.

Three.js deve permanecer independente do ciclo de renderização de componentes React.

React Three Fiber não faz parte da stack inicial aprovada.

WebGPU não faz parte da implementação inicial.

Shaders customizados devem utilizar GLSL ES 3.00.

Não introduzir outra tecnologia de renderização ou framework sem apresentar justificativa e identificar a mudança como proposta arquitetural.

## 3.12 Execução e desempenho

O processamento de análise musical, inteligência musical, geração procedural e renderização ocorre no dispositivo do usuário.

O backend auxiliar possui responsabilidade limitada à aquisição e entrega do áudio.

Um cenário não deve transferir análise musical ou renderização para o backend.

A implementação deve considerar:

- Reutilização de geometrias e materiais.
- Uso de instancing quando apropriado.
- Controle de alocações.
- Descarte correto de recursos.
- Uso consciente de shaders.
- Efeitos visuais proporcionais ao benefício.
- Consumo de memória e GPU.

Não adicionar complexidade de otimização sem necessidade comprovada.

---

# 4. Configurações dinâmicas de cada cenário

Esta seção contém as decisões que podem variar entre cenários.

A IA deve permitir que cada cenário escolha suas próprias características, sem assumir que existe uma configuração padrão universal.

## 4.1 Identidade visual

Cada cenário deve definir:

- Nome.
- Descrição.
- Conceito artístico.
- Estilo visual.
- Paleta de cores.
- Materiais predominantes.
- Formas e geometrias características.
- Atmosfera.
- Elementos ambientais.
- Escala e densidade visual.
- Referências visuais, quando disponíveis.

A IA pode propor esses elementos quando o usuário fornecer apenas uma ideia geral.

## 4.2 Composição do mundo

Cada cenário pode escolher:

- Tipo de ambiente.
- Organização espacial.
- Elementos principais.
- Elementos secundários.
- Distribuição de estruturas.
- Densidade de objetos.
- Variação de altura e profundidade.
- Distribuição de espaços vazios.
- Elementos próximos e distantes.
- Organização dos segmentos.
- Transições entre segmentos.

Não existe uma composição espacial obrigatória para todos os cenários.

## 4.3 Seleção de informações musicais

Cada cenário deve escolher quais informações musicais serão utilizadas.

A IA deve avaliar a relevância de cada feature para a identidade visual.

Para cada informação selecionada, registrar:

- Feature utilizada.
- Motivo da escolha.
- Sistema visual que poderá ser influenciado.
- Prioridade.
- Intensidade de influência.
- Comportamento esperado.
- Necessidade de suavização.
- Comportamento em caso de ausência ou baixa confiança.

O cenário pode ignorar qualquer feature que não contribua para sua experiência.

Não é necessário utilizar todas as informações disponíveis.

## 4.4 Seleção de propriedades visuais

Cada cenário deve definir quais propriedades visuais fazem parte de sua experiência.

Exemplos:

Geometry:
- Altura.
- Largura.
- Escala.
- Deformação.
- Densidade.
- Complexidade.

Architecture:
- Quantidade de estruturas.
- Distribuição.
- Altura de construções.
- Organização espacial.
- Transformações estruturais.

Lighting:
- Intensidade.
- Cor.
- Alcance.
- Direção.
- Pulsação.
- Frequência de variação.

Particles:
- Quantidade.
- Emissão.
- Velocidade.
- Tamanho.
- Cor.
- Trajetória.

Atmosphere:
- Densidade de neblina.
- Cor do ambiente.
- Visibilidade.
- Profundidade.
- Intensidade atmosférica.

Motion:
- Oscilação.
- Rotação.
- Deformação temporal.
- Velocidade de animações.
- Frequência de movimentos.

Esses exemplos não representam propriedades obrigatórias nem confirmam que todos esses parâmetros já existam no código.

A IA deve verificar a implementação antes de utilizá-los.

## 4.5 Matriz de interpretação musical

A principal configuração dinâmica de um cenário é sua matriz de interpretação.

Ela define como as informações musicais são convertidas em parâmetros visuais.

A matriz deve ser criada individualmente para cada cenário.

Estrutura conceitual:

| Campo | Descrição |
|---|---|
| musical_feature | Informação musical de origem |
| visual_target | Propriedade visual de destino |
| priority | Prioridade da relação |
| influence | Intensidade da influência |
| response_curve | Curva de resposta |
| smoothing | Suavização |
| min_value | Limite inferior |
| max_value | Limite superior |
| response_speed | Velocidade de resposta |
| confidence_threshold | Confiança mínima necessária |
| fallback | Comportamento quando a informação não está disponível |
| notes | Justificativa e observações |

Os campos acima são um modelo conceitual.

A implementação final deve respeitar os tipos e contratos existentes no projeto.

### Prioridades

A prioridade define a importância de uma relação musical dentro do cenário.

A IA pode utilizar uma escala numérica ou categorias, desde que mantenha consistência dentro do cenário.

Exemplo de escala proposta:

- `critical`: influencia fortemente a identidade do cenário.
- `high`: influência importante.
- `medium`: influência complementar.
- `low`: detalhe visual.
- `disabled`: relação não utilizada.

Não existe uma ordem universal de prioridades entre cenários.

### Influência

A influência define quanto uma feature altera uma propriedade visual.

Pode ser configurada com valores normalizados ou parâmetros adequados ao sistema visual.

A IA deve evitar valores arbitrários sem explicar sua finalidade.

### Curva de resposta

Cada relação pode escolher sua própria curva de resposta.

Exemplos:

- Linear.
- Exponencial.
- Logarítmica.
- Threshold.
- Smoothstep.
- Curva customizada.

A escolha depende do comportamento visual desejado.

### Suavização

Cada relação pode escolher sua própria suavização.

Exemplos:

- Sem suavização.
- Interpolação linear.
- Interpolação exponencial.
- Média temporal.
- Envelope de ataque e release.

A suavização deve evitar oscilações visuais indesejadas sem remover a identidade rítmica da música.

### Limites

Cada relação pode definir valores mínimos e máximos para impedir resultados visualmente inadequados.

Os limites devem considerar a escala e o significado real do parâmetro de destino.

### Confiança

Quando a informação musical possuir um indicador de confiança, o cenário poderá definir como utilizá-lo.

Exemplos:

- Ignorar eventos com confiança muito baixa.
- Reduzir a intensidade da influência.
- Utilizar um comportamento alternativo.
- Manter o último valor determinístico válido, quando apropriado.

Não inventar confiança para features que não a disponibilizam.

## 4.6 Relações entre várias features

Uma propriedade visual pode receber influência de mais de uma feature.

Exemplos conceituais:

- Iluminação influenciada por energia e transientes.
- Geometria influenciada por energia de longo prazo e mudanças estruturais.
- Movimento influenciado por BPM e subdivisões.
- Atmosfera influenciada por tensão e calmaria.

Essas relações devem ser definidas pelo cenário.

Quando várias features influenciam a mesma propriedade, a IA deve especificar como combinar as contribuições.

Possibilidades:

- Soma ponderada.
- Multiplicação.
- Máximo ou mínimo.
- Prioridade dominante.
- Camadas independentes.
- Função de combinação customizada.

A IA deve verificar se a combinação produz comportamento estável e previsível.

Não permitir que várias regras disputem o mesmo parâmetro sem uma estratégia explícita de resolução.

## 4.7 Elementos e comportamentos exclusivos

Cada cenário pode possuir sistemas que não existem em outros cenários.

Exemplos:

- Estruturas que se reorganizam.
- Elementos que surgem em determinados eventos musicais.
- Arquitetura que muda durante transições.
- Criaturas ou veículos ambientais.
- Efeitos de distorção.
- Mudanças de horizonte.
- Elementos que acompanham padrões rítmicos.
- Eventos visuais associados a clímax.

Esses comportamentos podem ser específicos do cenário.

Entretanto, devem respeitar determinismo, sincronização, desempenho e limites de responsabilidade.

Se uma funcionalidade puder ser reutilizada por outros cenários, a IA deve avaliar se ela merece ser promovida a um sistema compartilhado.

## 4.8 Configuração procedural

Cada cenário pode definir:

- Regras de composição.
- Famílias de objetos.
- Regras de distribuição.
- Variações geométricas.
- Densidade.
- Regras de posicionamento.
- Regras de transição.
- Uso de seeds secundárias.
- Comportamento de cada segmento.

A geração deve ser baseada em entradas determinísticas.

A IA deve distinguir parâmetros de composição estáticos de parâmetros que variam ao longo da música.

---

# 5. Processo para criar um cenário

Quando `operation=create`, seguir a sequência abaixo.

## Etapa 1 — Consultar o projeto

Antes de implementar:

1. Ler `PRODUCT_SPEC.md`.
2. Ler `TECH_STACK.md`.
3. Ler `TECHNICAL_ARCHITECTURE.md`.
4. Consultar as instruções de desenvolvimento do repositório, como `AGENTS.md`, quando disponíveis.
5. Inspecionar a estrutura atual do código.
6. Identificar cenários já existentes.
7. Identificar os contratos e sistemas compartilhados disponíveis.
8. Identificar quais capacidades visuais já estão implementadas.

Não assumir que a documentação representa necessariamente o estado atual do código.

Quando houver divergência, identificar a divergência e não modificar silenciosamente decisões aprovadas.

## Etapa 2 — Definir identidade visual

Com as informações disponíveis, produzir uma proposta contendo:

- Nome.
- Identificador.
- Descrição.
- Conceito visual.
- Paleta.
- Geometria.
- Materiais.
- Ambiente.
- Composição.
- Elementos principais.
- Elementos secundários.

Se o usuário já forneceu referências suficientes, não perguntar novamente.

Se faltar uma decisão que altere substancialmente a identidade visual, perguntar antes de implementar.

## Etapa 3 — Definir composição do mundo

Descrever:

- Organização espacial.
- Elementos recorrentes.
- Distribuição de objetos.
- Relação entre estruturas.
- Organização dos segmentos.
- Variações possíveis.
- Transições entre áreas.

A composição deve ser coerente com a identidade visual.

## Etapa 4 — Selecionar features musicais

Analisar o catálogo compartilhado e escolher as features que fazem sentido.

Para cada feature selecionada, explicar:

- Por que será utilizada.
- O que representa para o cenário.
- Quais comportamentos visuais pode influenciar.

Não criar mapeamentos apenas para preencher uma tabela.

## Etapa 5 — Definir propriedades visuais

Selecionar as propriedades que realmente fazem parte do cenário.

Separar:

- Propriedades estruturais.
- Propriedades reativas.
- Propriedades rítmicas.
- Propriedades interpretativas.
- Propriedades independentes da música.

## Etapa 6 — Construir a matriz de interpretação

Definir as relações entre features musicais e propriedades visuais.

Para cada relação, definir:

- Prioridade.
- Influência.
- Curva de resposta.
- Suavização.
- Limites.
- Velocidade de resposta.
- Tratamento de confiança.
- Fallback.

Verificar conflitos entre relações que controlam a mesma propriedade.

## Etapa 7 — Definir comportamento temporal

Descrever como o cenário reage a:

- Música calma.
- Aumento gradual de energia.
- Batidas.
- Transientes.
- Transições.
- Pausas.
- Clímax.
- Mudanças estruturais.

Esses comportamentos devem ser descritos como respostas possíveis do cenário, não como regras musicais universais.

Considerar também o que acontece quando uma feature está indisponível.

## Etapa 8 — Planejar implementação

Antes de alterar o código, apresentar ou construir um plano técnico coerente com o repositório.

Identificar:

- Arquivos novos.
- Arquivos existentes que precisam ser alterados.
- Interfaces necessárias.
- Sistemas compartilhados que serão reutilizados.
- Recursos visuais necessários.
- Sistemas exclusivos do cenário.
- Estratégia de geração procedural.
- Estratégia de sincronização.
- Estratégia de testes.

Evitar criar abstrações genéricas prematuras.

## Etapa 9 — Implementar

Implementar o cenário utilizando os contratos existentes.

Manter separação entre:

- Identidade e configuração.
- Interpretação musical.
- Geração procedural.
- Composição visual.
- Renderização.

Não colocar toda a implementação em um único componente ou arquivo.

Não duplicar sistemas compartilhados.

Não alterar outros cenários sem necessidade.

## Etapa 10 — Validar

Executar as verificações possíveis:

- Compatibilidade com os contratos do projeto.
- Compilação TypeScript.
- Build Vite.
- Testes automatizados existentes.
- Determinismo.
- Reconstrução temporal.
- Comportamento com features ausentes.
- Comportamento com baixa confiança.
- Limites visuais.
- Descarte de recursos.
- Desempenho.

Não afirmar que uma validação foi executada se ela não foi realmente realizada.

## Etapa 11 — Documentar

Registrar:

- Identidade do cenário.
- Versão.
- Descrição visual.
- Capacidades utilizadas.
- Features selecionadas.
- Matriz de interpretação.
- Comportamentos temporais.
- Decisões técnicas específicas.
- Limitações conhecidas.

Identificar cada decisão como:

- `DECIDED`
- `PROPOSED`
- `OPEN`

Não promover propostas a decisões aprovadas sem autorização.

---

# 6. Processo para atualizar um cenário

Quando `operation=update`, seguir as etapas abaixo.

## 6.1 Inspecionar o estado atual

Antes de modificar:

1. Localizar a implementação do cenário.
2. Ler sua documentação.
3. Identificar sua versão.
4. Identificar seus sistemas exclusivos.
5. Identificar suas dependências compartilhadas.
6. Entender seus mapeamentos musicais.
7. Identificar testes existentes.

Não reconstruir o cenário do zero sem necessidade.

## 6.2 Classificar a alteração

Classificar a solicitação em uma ou mais categorias:

- Identidade visual.
- Composição do mundo.
- Geometria.
- Materiais.
- Cores.
- Iluminação.
- Partículas.
- Atmosfera.
- Movimento.
- Mapeamento musical.
- Prioridades.
- Comportamento temporal.
- Geração procedural.
- Desempenho.
- Arquitetura.
- Correção de bugs.

## 6.3 Preservar o que não foi solicitado

Uma atualização deve preservar:

- A identidade visual não relacionada à solicitação.
- Os comportamentos que continuam válidos.
- As regras globais.
- A compatibilidade com os sistemas compartilhados.
- O determinismo.
- A sincronização.

Não alterar características do cenário apenas porque a IA prefere outra solução.

## 6.4 Avaliar impacto

Antes de implementar, identificar se a alteração afeta:

- Apenas o cenário.
- Um sistema visual compartilhado.
- O catálogo de capacidades visuais.
- O catálogo de informações musicais.
- A arquitetura global.
- A identidade determinística.
- Outros cenários.

Mudanças locais devem permanecer locais sempre que possível.

Mudanças globais exigem justificativa e avaliação de impacto.

## 6.5 Versionamento

Se uma alteração modificar a geração ou a identidade do mundo, avaliar a necessidade de atualizar a versão do cenário.

A versão deve refletir mudanças relevantes para a identidade e reprodução do cenário.

Não atualizar versões automaticamente para qualquer ajuste cosmético sem avaliar as regras de versionamento existentes.

Se a estratégia de versionamento ainda não estiver definida, registrar a decisão como `OPEN` ou `PROPOSED`.

---

# 7. Estrutura recomendada da documentação do cenário

Cada cenário deve possuir uma documentação própria.

Estrutura sugerida:

# Scenario: [Scenario Name]

## 1. Metadata
- ID
- Name
- Version
- Status
- Description

## 2. Visual Identity
- Concept
- Art direction
- Color palette
- Geometry
- Materials
- Atmosphere
- Visual references

## 3. World Composition
- Environment
- Spatial organization
- Main elements
- Secondary elements
- Segment composition
- Transitions

## 4. Musical Features
- Selected features
- Reasons for selection
- Expected availability
- Confidence handling

## 5. Visual Capabilities
- Selected visual systems
- Controlled properties
- Static properties
- Dynamic properties

## 6. Musical Interpretation Matrix
- Feature-to-property mappings
- Priorities
- Influence
- Response curves
- Smoothing
- Limits
- Fallbacks
- Conflict resolution

## 7. Temporal Behavior
- Calm sections
- Energy increases
- Rhythmic events
- Transitions
- Pauses
- Climaxes

## 8. Procedural Generation
- Composition rules
- Seed usage
- Segment generation
- Deterministic behavior

## 9. Technical Implementation
- Files
- Interfaces
- Dependencies
- Shared systems
- Scenario-specific systems

## 10. Performance
- Geometry considerations
- Instancing
- Materials
- Shader complexity
- Resource lifecycle

## 11. Testing
- Determinism
- Arbitrary-time reconstruction
- Feature fallbacks
- Rendering
- Performance

## 12. Decisions and Open Questions
- DECIDED
- PROPOSED
- OPEN

---

# 8. Critérios de qualidade

Um cenário só deve ser considerado pronto quando atender aos critérios aplicáveis abaixo.

## Arquitetura

- Não duplica a análise musical.
- Não assume responsabilidades globais.
- Utiliza os contratos compartilhados.
- Mantém sua interpretação musical isolada.
- Não introduz dependências desnecessárias.

## Identidade visual

- Possui uma identidade reconhecível.
- A composição é coerente.
- Os elementos principais e secundários estão definidos.
- A experiência não se reduz a um visualizador de áudio convencional.

## Interpretação musical

- Utiliza features relevantes.
- Possui mapeamentos explícitos.
- Define prioridades.
- Define limites e suavização quando necessários.
- Não depende de features indisponíveis sem fallback.
- Não apresenta conflitos não resolvidos entre regras.

## Determinismo

- Utiliza seeds estáveis.
- Gera segmentos reproduzíveis.
- Não depende do FPS.
- Não depende do histórico de frames.
- Permite reconstrução temporal.

## Desempenho

- Evita alocações desnecessárias.
- Reutiliza recursos quando possível.
- Considera a quantidade de objetos.
- Evita shaders desnecessariamente caros.
- Libera recursos corretamente.

## Manutenibilidade

- Possui responsabilidades bem separadas.
- É documentado.
- Pode ser atualizado sem comprometer outros cenários.
- Possui testes adequados.

---

# 9. Regras de comportamento da IA

Durante toda a execução desta skill, a IA deve seguir estas regras:

1. Consultar os documentos oficiais do projeto antes de propor alterações arquiteturais.
2. Distinguir regras fixas de configurações específicas do cenário.
3. Não inventar contratos ou APIs existentes.
4. Verificar o código antes de assumir que um sistema está implementado.
5. Não transformar exemplos desta skill em regras obrigatórias.
6. Não forçar o uso de todas as features musicais.
7. Não forçar o uso de todas as capacidades visuais.
8. Não estabelecer prioridades universais entre features.
9. Não implementar análise musical dentro do cenário.
10. Não comprometer o determinismo por efeitos visuais.
11. Não modificar a câmera ou o fluxo global da experiência.
12. Não alterar a stack tecnológica aprovada sem justificativa.
13. Não modificar outros cenários sem necessidade.
14. Não adicionar sistemas compartilhados apenas por antecipação.
15. Não tratar recomendações arquiteturais como decisões obrigatórias.
16. Documentar decisões relevantes.
17. Identificar claramente o que é decisão, proposta ou questão em aberto.
18. Perguntar ao usuário somente quando uma informação ausente for realmente necessária.
19. Quando houver liberdade de escolha, propor a solução mais coerente com a identidade do cenário.
20. Explicar decisões técnicas que afetem determinismo, desempenho ou arquitetura.

---

# 10. Formato de entrega

Ao concluir uma criação ou atualização, apresentar um resumo com:

## Resultado
- O que foi criado ou atualizado.

## Identidade visual
- Características principais do cenário.

## Interpretação musical
- Features utilizadas.
- Propriedades visuais controladas.
- Principais mapeamentos e prioridades.

## Arquitetura
- Sistemas compartilhados reutilizados.
- Sistemas específicos implementados.
- Arquivos criados ou modificados.

## Validação
- Testes executados.
- Resultado do build.
- Limitações ou verificações pendentes.

## Decisões pendentes
- Questões `OPEN`.
- Propostas que precisam de aprovação.

Não declarar uma implementação concluída quando houver etapas essenciais não executadas.

A entrega deve ser objetiva, mas suficientemente detalhada para permitir revisão técnica.

---

# 11. Princípio fundamental

O Sonora fornece:

1. Um vocabulário musical compartilhado.
2. Um conjunto extensível de capacidades visuais.
3. Uma infraestrutura comum de geração procedural, sincronização e renderização.

Cada cenário define:

1. Sua própria identidade visual.
2. Quais informações musicais são relevantes.
3. Quais propriedades visuais serão utilizadas.
4. Como as informações musicais influenciam essas propriedades.
5. Quais prioridades e comportamentos tornam sua experiência única.

A IA deve preservar essa separação em todas as decisões de design e implementação.

**O objetivo não é fazer todos os cenários reagirem à música da mesma forma. O objetivo é permitir que todos utilizem a mesma infraestrutura para criar experiências visuais diferentes.**