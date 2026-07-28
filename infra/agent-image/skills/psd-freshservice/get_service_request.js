#!/usr/bin/env node
/**
 * get_service_request.js — fetch a service-request ticket with its
 * conversation history, requester profile, and form data.
 *
 * Usage:
 *   node get_service_request.js --user <email> --id <ticket_id>
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch, requireTicketId } = require('./lib/api');

async function fetchRequester(apiKey, requesterId) {
  if (!requesterId) return null;
  const response = await fsFetch(apiKey, `/requesters/${requesterId}`);
  if (!response.__ok || !response.data.requester) return null;
  const requester = response.data.requester;
  return {
    name: `${requester.first_name || ''} ${requester.last_name || ''}`.trim(),
    email: requester.primary_email,
    department: (requester.department_names || [])[0] || null,
    job_title: requester.job_title,
  };
}

function serviceRequestOutput(ticket, requester, serviceItems) {
  const firstItem = serviceItems[0];
  return {
    ticket: {
      id: ticket.id,
      subject: ticket.subject,
      type: ticket.type,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      sub_category: ticket.sub_category,
      item_category: ticket.item_category,
      workspace_id: ticket.workspace_id,
      created_at: ticket.created_at,
      due_by: ticket.due_by,
      is_escalated: ticket.is_escalated,
      approval_status: ticket.approval_status,
      approval_status_name: ticket.approval_status_name,
    },
    requester,
    form_data: firstItem?.custom_fields || {},
    service_items: serviceItems,
    service_item: firstItem ? {
      id: firstItem.id,
      name: firstItem.name,
      quantity: firstItem.quantity,
      cost: firstItem.cost,
    } : null,
    conversations: (ticket.conversations || []).map((conversation) => ({
      id: conversation.id,
      body_text: conversation.body_text,
      private: conversation.private,
      created_at: conversation.created_at,
      user_id: conversation.user_id,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: get_service_request.js --user <email> --id <ticket_id>');
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const id = requireTicketId(args);

  const apiKey = getApiKey(userEmail);
  const ticketRes = await fsFetch(apiKey, `/tickets/${id}?include=conversations,requester`);
  if (!ticketRes.__ok) fail(ticketRes.error, 'upstream_error');
  const ticket = ticketRes.data.ticket || {};

  const itemsRes = await fsFetch(apiKey, `/tickets/${id}/requested_items`);
  const requestedItems = itemsRes.__ok ? (itemsRes.data.requested_items || []) : [];

  const requester = await fetchRequester(apiKey, ticket.requester_id);

  // Map all requested items — a service request may contain multiple line
  // items (e.g. "Chromebook + charger"), not just the first one.
  const serviceItems = requestedItems.map((item) => ({
    id: item.service_item_id,
    name: item.service_item_name,
    quantity: item.quantity,
    cost: item.cost_per_request,
    custom_fields: item.custom_fields || {},
  }));

  emit(serviceRequestOutput(ticket, requester, serviceItems));
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
