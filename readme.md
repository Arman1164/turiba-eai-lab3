## Architecture Rationale

The orchestrator implements the **Saga Pattern** to manage distributed transactions across the checkout microservices. This centralized approach ensures **eventual consistency** across independent services.

### Key Implementation Decisions

* **Sequential Workflow**: Services are invoked in a strict linear order: Payment Authorize, Inventory Reserve, Shipping Create, and Notification Send. This prevents resource allocation (like shipping or stock) if financial authorization fails.
* **Compensation Strategy (Rollbacks)**: To maintain data integrity during failures, the system executes reverse "undo" actions:
    * **Inventory Failure**: Triggers a Payment Refund.
    * **Shipping or Notification Failure**: Triggers an Inventory Release followed by a Payment Refund.
    * Any failure within a compensation step returns a `422 compensation_failed` status.
* **Idempotency and Reliability**:
    * The system uses the `Idempotency-Key` header to prevent duplicate transactions.
    * It returns `409 Conflict` if the payload changes for an existing key or if a transaction is currently in progress.
* **Restart-Safe Persistence**: Transaction states are persisted in `/data/idempotency-store.json` and `/data/saga-store.json`. This allows the orchestrator to survive container restarts and correctly replay results for previous requests.
* **Timeout Management**: Downstream calls are governed by Axios timeouts. If a service fails to respond within the allotted time, the orchestrator terminates the flow, triggers compensations, and returns a `504 Timeout` status.

---

## AI Usage Note

AI assistance was utilized for designing the Saga state machine logic and refining asynchronous error handling. The final implementation was manually reviewed to ensure strict compliance with the required execution sequence and was validated using the provided Jest test suites.   