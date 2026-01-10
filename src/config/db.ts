import config from "config";
import mongoose from "mongoose";

export const initDb = async () => {
    await mongoose.connect(config.get("database.url"));
};
