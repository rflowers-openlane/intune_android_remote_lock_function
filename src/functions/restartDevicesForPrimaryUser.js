const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { handleRestartDevicesRequest } = require('../lib/intuneRestartService');

app.http('restartDevicesForPrimaryUser', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const correlationId = randomUUID();

    try {
      const body = await request.json().catch(() => null);
      const result = await handleRestartDevicesRequest({
        body,
        request,
        context,
        correlationId
      });

      return jsonResponse(result.status, result.body);
    } catch (error) {
      context.error(error);

      return jsonResponse(error.statusCode || 500, {
        correlationId,
        error: error.message || 'Unexpected error.'
      });
    }
  }
});

function jsonResponse(status, body) {
  return {
    status,
    jsonBody: body,
    headers: {
      'Content-Type': 'application/json'
    }
  };
}
