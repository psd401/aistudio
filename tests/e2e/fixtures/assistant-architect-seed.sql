-- Assistant Architect fixture for the parallel-prompt persistence E2E
-- (tests/e2e/assistant-architect-parallel-persistence.spec.ts).
--
-- Seeds an APPROVED architect owned by the seeded admin (users.id = 2, cognito_sub
-- 'e2e-test-user') so it shows in the admin's "My Approved Assistants" list, plus
-- two prompts at the SAME position in DIFFERENT parallel_groups so the ReactFlow
-- prompts editor renders parallel prompt nodes. Idempotent.
--
-- model_id 9 = a seeded active ai_model on local dev. If absent, fall back to any
-- model so the FK holds.

INSERT INTO assistant_architects (id, name, description, status, user_id, is_parallel)
VALUES (9000, 'E2E Parallel Architect',
        'Fixture: two parallel prompts for persistence E2E', 'approved', 2, true)
ON CONFLICT (id) DO UPDATE
  SET user_id = 2, status = 'approved', is_parallel = true;

INSERT INTO chain_prompts (id, assistant_architect_id, name, content, model_id, position, parallel_group)
VALUES
  (9001, 9000, 'Branch A', 'Analyze the input from angle A.',
   COALESCE((SELECT id FROM ai_models WHERE id = 9), (SELECT id FROM ai_models ORDER BY id LIMIT 1)), 1, 0),
  (9002, 9000, 'Branch B', 'Analyze the input from angle B.',
   COALESCE((SELECT id FROM ai_models WHERE id = 9), (SELECT id FROM ai_models ORDER BY id LIMIT 1)), 1, 1)
ON CONFLICT (id) DO NOTHING;
