import mongoose from "mongoose";

export interface Topping {
    _id?: mongoose.Types.ObjectId;
    name: string;
    price: number;
    tenantId: string;
    image: string;
}

export interface CreataeRequestBody {
    name: string;
    price: number;
    tenantId: string;
}

export enum ToppingEvents {
    TOPPING_CREATE = "TOPPING_CREATE",
    TOPPING_UPDATE = "TOPPING_UPDATE",
    TOPPING_DELETE = "TOPPING_DELETE",
}
