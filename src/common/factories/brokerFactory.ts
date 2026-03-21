import config from "config";
import { KafkaProducerBroker } from "../../config/kafka";
import { MessageProducerBroker } from "../types/broker";

let messageProducer: MessageProducerBroker | null = null;

export const createMessageProducerBroker = (): MessageProducerBroker => {
    // making singletone
    if (!messageProducer) {
        messageProducer = new KafkaProducerBroker("catalog-service", [
            config.get("kafka.broker"),
        ]);
    }

    return messageProducer;
};
