-- Assistant Architect fixture for the parallel-prompt persistence E2E
-- (tests/e2e/assistant-architect-parallel-persistence.spec.ts).
--
-- Seeds an APPROVED architect owned by the seeded admin (resolved by stable
-- cognito_sub, never a sequence-dependent numeric id) so it shows in the
-- admin's "My Approved Assistants" list, plus
-- two prompts at the SAME position in DIFFERENT parallel_groups so the ReactFlow
-- prompts editor renders parallel prompt nodes. Idempotent.
--
-- model_id 9 = a seeded active ai_model on local dev. If absent, fall back to any
-- model so the FK holds.

INSERT INTO assistant_architects (id, name, description, status, user_id, is_parallel)
SELECT 9000, 'E2E Parallel Architect',
       'Fixture: two parallel prompts for persistence E2E', 'approved', user_row.id, true
FROM users user_row
WHERE user_row.cognito_sub = 'e2e-test-user'
ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id, status = 'approved', is_parallel = true,
      model_routing_mode = 'legacy', model_routing_family = NULL;

INSERT INTO chain_prompts (id, assistant_architect_id, name, content, model_id, position, parallel_group)
VALUES
  (9001, 9000, 'Branch A', 'Analyze the input from angle A.',
   COALESCE((SELECT id FROM ai_models WHERE id = 9), (SELECT id FROM ai_models ORDER BY id LIMIT 1)), 1, 0),
  (9002, 9000, 'Branch B', 'Analyze the input from angle B.',
   COALESCE((SELECT id FROM ai_models WHERE id = 9), (SELECT id FROM ai_models ORDER BY id LIMIT 1)), 1, 1)
ON CONFLICT (id) DO NOTHING;

-- A deterministic runtime file input exercises the repository-backed temporary
-- attachment contract without calling a live model. The product-migration E2E
-- intercepts only upload/status/execution transport and proves that the form
-- sends an opaque repository reference rather than extracted document text.
INSERT INTO tool_input_fields
  (id, assistant_architect_id, name, label, field_type, position, options)
VALUES
  (
    9003,
    9000,
    'e2e_knowledge_document',
    'E2E knowledge document',
    'file_upload',
    0,
    NULL
  )
ON CONFLICT (id) DO UPDATE
SET assistant_architect_id = EXCLUDED.assistant_architect_id,
    name = EXCLUDED.name,
    label = EXCLUDED.label,
    field_type = EXCLUDED.field_type,
    position = EXCLUDED.position,
    options = EXCLUDED.options;

INSERT INTO assistant_architects
  (id, name, description, status, user_id, is_parallel, model_routing_mode, model_routing_family)
SELECT fixture.id,
       fixture.name,
       fixture.description,
       'draft',
       user_row.id,
       false,
       fixture.routing_mode,
       fixture.routing_family
FROM users user_row
CROSS JOIN (
  VALUES
    (9010, 'E2E Standard Routed Architect',
     'Fixture: automatic Standard model routing', 'standard', NULL::varchar),
    (9020, 'E2E Advanced Routed Architect',
     'Fixture: automatic Claude-family routing', 'advanced', 'anthropic'::varchar)
) AS fixture(id, name, description, routing_mode, routing_family)
WHERE user_row.cognito_sub = 'e2e-test-user'
ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      status = 'draft',
      model_routing_mode = EXCLUDED.model_routing_mode,
      model_routing_family = EXCLUDED.model_routing_family;

INSERT INTO chain_prompts (id, assistant_architect_id, name, content, model_id, position)
VALUES
  (9011, 9010, 'Standard prompt', 'Create a concise lesson plan.',
   COALESCE((SELECT id FROM ai_models WHERE id = 9), (SELECT id FROM ai_models ORDER BY id LIMIT 1)), 0),
  (9021, 9020, 'Advanced prompt', 'Analyze this request carefully.',
   COALESCE((SELECT id FROM ai_models WHERE id = 9), (SELECT id FROM ai_models ORDER BY id LIMIT 1)), 0)
ON CONFLICT (id) DO NOTHING;

-- Staff-owned draft proves the default Assistant Architect audience can reach
-- the Repository Manager capability and bind an explicitly shared repository.
INSERT INTO assistant_architects
  (id, name, description, status, user_id, is_parallel, model_routing_mode, model_routing_family)
SELECT
  9030,
  'E2E Staff Repository Architect',
  'Fixture: staff repository picker access',
  'draft',
  user_row.id,
  false,
  'legacy',
  NULL
FROM users user_row
WHERE user_row.cognito_sub = 'e2e-staff-user'
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id,
    status = 'draft',
    model_routing_mode = 'legacy',
    model_routing_family = NULL;

INSERT INTO chain_prompts
  (id, assistant_architect_id, name, content, model_id, position)
VALUES
  (
    9031,
    9030,
    'Staff repository prompt',
    'Use the selected repository to answer the request.',
    COALESCE(
      (SELECT id FROM ai_models WHERE id = 9),
      (SELECT id FROM ai_models ORDER BY id LIMIT 1)
    ),
    0
  )
ON CONFLICT (id) DO UPDATE
SET assistant_architect_id = EXCLUDED.assistant_architect_id,
    name = EXCLUDED.name,
    content = EXCLUDED.content,
    model_id = EXCLUDED.model_id,
    position = EXCLUDED.position;
