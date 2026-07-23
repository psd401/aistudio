export class NexusSpecialistUnavailableError extends Error {
  readonly specialist: "image" | "psd-data" | "web-search"
  readonly reconnectConnectorIds: string[]

  constructor(
    specialist: "image" | "psd-data" | "web-search",
    message: string,
    reconnectConnectorIds: string[] = []
  ) {
    super(message)
    this.name = "NexusSpecialistUnavailableError"
    this.specialist = specialist
    this.reconnectConnectorIds = reconnectConnectorIds
  }
}
