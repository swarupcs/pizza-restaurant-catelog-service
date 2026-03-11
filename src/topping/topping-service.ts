import toppingModel from "./topping-model";
import { Topping } from "./topping-types";

export class ToppingService {
    async create(topping: Topping) {
        return await toppingModel.create(topping);
    }

    async getAll(tenantId: string) {
        // todo: !Important, add pagination
        return await toppingModel.find({ tenantId });
    }
}
