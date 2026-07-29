'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  loadCallArgs,
  main,
  run,
  statusForCode,
} = require('./run');

const callerTool = {
  name: 'create_example_request',
  description: 'Creates an example request',
  inputSchema: {
    type: 'object',
    properties: {
      requester_email: {
        type: 'string',
        description: 'Verified requester [caller-bound]',
      },
      summary: { type: 'string' },
    },
  },
};

test('statusForCode retains the established exit contract', () => {
  assert.equal(statusForCode(11), 'not-configured');
  assert.equal(statusForCode(12), 'transport-error');
  assert.equal(statusForCode(13), 'gateway-error');
  assert.equal(statusForCode(2), 'bad-args');
});

test('list groups the dynamically discovered roster by family', async () => {
  const result = await run(['list'], {
    listGatewayTools: async () => [
      callerTool,
      {
        name: 'get_example_request_schema',
        description: 'Example schema',
        inputSchema: {},
      },
    ],
  });
  assert.deepEqual(
    result.families.map((group) => group.family),
    ['example_request']
  );
});

test('describe returns the live tool schema', async () => {
  const result = await run(['describe', '--tool', callerTool.name], {
    listGatewayTools: async () => [callerTool],
  });
  assert.deepEqual(result, callerTool);
});

test('call loads inline JSON and overwrites every caller-bound field from --user', async () => {
  let seen;
  const result = await run(
    [
      'call',
      '--tool',
      callerTool.name,
      '--user',
      'Owner@psd401.net',
      '--json',
      '{"requester_email":"attacker@psd401.net","summary":"Ready"}',
    ],
    {
      listGatewayTools: async () => [callerTool],
      callGatewayTool: async (...args) => {
        seen = args;
        return { isError: false, data: { success: true } };
      },
    }
  );
  assert.deepEqual(result, { success: true });
  assert.equal(seen[0], callerTool.name);
  assert.deepEqual({ ...seen[1] }, {
    requester_email: 'Owner@psd401.net',
    summary: 'Ready',
  });
});

test('call requires a marker for every tool outside get/list', async () => {
  for (const toolName of [
    'approve_example_request',
    'cancel_example_request',
    'create_example_request',
    'delete_example_request',
    'reject_example_request',
    'submit_example_request',
    'update_example_request',
    'CREATE_example_request',
    'example_request_submit',
    'search_example_request',
    'submitx',
  ]) {
    const tool = {
      name: toolName,
      description: 'Mutates an example request',
      inputSchema: { type: 'object', properties: {} },
    };
    await assert.rejects(
      () => run(
        ['call', '--tool', tool.name, '--user', 'owner@psd401.net'],
        {
          listGatewayTools: async () => [tool],
          callGatewayTool: async () => ({ isError: false, data: {} }),
        }
      ),
      (error) => error.code === 13 && error.message.includes('[caller-bound]')
    );
  }
});

test('call preserves owner binding for the legacy caller-scoped list tool', async () => {
  let seen;
  const tool = {
    name: 'list_supervised_employees',
    description: 'Legacy caller-scoped roster',
    inputSchema: {
      type: 'object',
      properties: {
        evaluator_email: {
          type: 'string',
          description: 'Evaluator email without the new marker',
        },
      },
    },
  };
  await run(
    [
      'call',
      '--tool',
      tool.name,
      '--user',
      'owner@psd401.net',
      '--json',
      '{"evaluator_email":"attacker@psd401.net"}',
    ],
    {
      listGatewayTools: async () => [tool],
      callGatewayTool: async (_toolName, args) => {
        seen = args;
        return { isError: false, data: { success: true } };
      },
    }
  );
  assert.equal(seen.evaluator_email, 'owner@psd401.net');
});

test('call accepts --json-file payloads through the validated reader', async () => {
  let seen;
  await run(
    [
      'call',
      '--tool',
      callerTool.name,
      '--user',
      'owner@psd401.net',
      '--json-file',
      '/tmp/workflow.json',
    ],
    {
      listGatewayTools: async () => [callerTool],
      readFileSync: () => '{"summary":"Line one\\nLine two"}',
      callGatewayTool: async (_toolName, args) => {
        seen = args;
        return { isError: false, data: { success: true } };
      },
    }
  );
  assert.equal(seen.summary, 'Line one\nLine two');
});

test('payload handling rejects conflicting or non-object JSON', () => {
  assert.throws(
    () => loadCallArgs({ json: '{}', json_file: '/tmp/workflow.json' }),
    /only one/
  );
  assert.throws(() => loadCallArgs({ json: '[]' }), /JSON object/);
});

test('legacy and unknown subcommands return the standard usage error', async () => {
  for (const subcommand of ['schema', 'list-employees', 'submit', 'unknown']) {
    let output = '';
    const code = await main(
      [subcommand],
      {},
      (value) => {
        output += value;
        return true;
      }
    );
    assert.equal(code, 2);
    const failure = JSON.parse(output);
    assert.equal(failure.status, 'bad-args');
    assert.match(failure.message, /Usage:/);
  }
});

test('missing subcommand is bad-args while explicit help succeeds', async () => {
  let missingOutput = '';
  assert.equal(
    await main([], {}, (value) => {
      missingOutput += value;
      return true;
    }),
    2
  );
  assert.equal(JSON.parse(missingOutput).status, 'bad-args');

  let helpOutput = '';
  assert.equal(
    await main(['--help'], {}, (value) => {
      helpOutput += value;
      return true;
    }),
    0
  );
  assert.match(helpOutput, /^Usage:/);
});
