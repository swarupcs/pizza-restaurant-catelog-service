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
