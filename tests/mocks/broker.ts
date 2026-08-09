/**
 * Stand-in for src/common/factories/brokerFactory.
 *
 * The product and topping routers call `createMessageProducerBroker()` at
 * module load, which builds a real KafkaProducerBroker. Constructing one is
 * harmless, but `sendMessage` would try to reach a broker — and every create
 * and update path publishes an event. Specs opt in with:
 *
 *     jest.mock("../../src/common/factories/brokerFactory", () => require("../mocks/broker"));
 *
 * `sendMessage` is the interesting one: the events on the `product` and
 * `topping` topics are the contract order-service consumes to keep its price
 * cache warm, so the tests assert on the exact payload.
 */
export const sendMessage = jest.fn<Promise<void>, [string, string]>();
export const connect = jest.fn<Promise<void>, []>();
export const disconnect = jest.fn<Promise<void>, []>();

export const createMessageProducerBroker = jest.fn(() => ({
    connect,
    disconnect,
    sendMessage,
}));

export const resetBrokerMocks = () => {
    sendMessage.mockClear();
    connect.mockClear();
    disconnect.mockClear();
};

/** Parses the JSON payload of the nth sendMessage call. */
export const publishedMessage = (call = 0) => {
    const [topic, payload] = sendMessage.mock.calls[call];
    return { topic, body: JSON.parse(payload) as Record<string, unknown> };
};
