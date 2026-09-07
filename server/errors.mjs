export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
