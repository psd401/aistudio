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

  let requester = null;
  if (ticket.requester_id) {
    const r = await fsFetch(apiKey, `/requesters/${ticket.requester_id}`);
    if (r.__ok && r.data.requester) {
      const rr = r.data.requester;
      requester = {
        name: `${rr.first_name || ''} ${rr.last_name || ''}`.trim(),
        email: rr.primary_email,
        department: (rr.department_names || [])[0] || null,
        job_title: rr.job_title,
      };
    }
  }

  // Map all requested items — a service request may contain multiple line
  // items (e.g. "Chromebook + charger"), not just the first one.
  const serviceItems = requestedItems.map((item) => ({
    id: item.service_item_id,
    name: item.service_item_name,
    quantity: item.quantity,
    cost: item.cost_per_request,
    custom_fields: item.custom_fields || {},
  }));

  emit({
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
    // Preserve backward-compat: form_data from the first item (most common case)
    form_data: serviceItems[0]?.custom_fields || {},
    service_items: serviceItems,
    // Legacy singular field for backward compat — first item only
    service_item: serviceItems[0] ? {
      id: serviceItems[0].id,
      name: serviceItems[0].name,
      quantity: serviceItems[0].quantity,
      cost: serviceItems[0].cost,
    } : null,
    conversations: (ticket.conversations || []).map((c) => ({
      id: c.id,
      body_text: c.body_text,
      private: c.private,
      created_at: c.created_at,
      user_id: c.user_id,
    })),
  });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
