export interface FreshserviceTicketData {
  id: number | string
  display_id?: string | number
  [key: string]: unknown
}

export function parseFreshserviceTicketId(
  ticket: FreshserviceTicketData
): number | null {
  const ticketId =
    typeof ticket.id === "string"
      ? Number.parseInt(ticket.id, 10)
      : ticket.id
  return !ticketId || Number.isNaN(ticketId) || ticketId <= 0
    ? null
    : ticketId
}
