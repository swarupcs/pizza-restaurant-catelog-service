import config from "config";
import mongoose from "mongoose";

/**
 * Connects to the database named in config/test.yaml
 * (mongodb://localhost:27017/catalog-service-test by default).
 *
 * A real MongoDB is used rather than an in-memory one because
 * ProductService.getProducts runs an aggregation pipeline with $lookup and
 * aggregatePaginate — the part most worth testing, and the part a fake would
 * be least faithful to.
 */
export const connectDb = async () => {
    await mongoose.connect(config.get("database.url"));
};

export const disconnectDb = async () => {
    await mongoose.connection.close();
};

/**
 * Empties every collection without dropping the database, so indexes built
 * from the schemas survive between tests.
 */
export const clearDb = async () => {
    const collections = await mongoose.connection.db!.collections();
    for (const collection of collections) {
        await collection.deleteMany({});
    }
};
