# Catalog Service — API Documentation

> **Base URL:** `http://localhost:5502`  
> **Postman Collection:** [`Catalog-Service.postman_collection.json`](./Catalog-Service.postman_collection.json)

## Overview

The Catalog Service manages the product catalog for the pizza restaurant platform. It handles categories, products, and toppings — all with image upload support via AWS S3.

### Authentication Mechanism

Protected endpoints rely on the `accessToken` **httpOnly cookie** set by the auth-service after login. No manual token handling is required.

### Roles

| Role      | Access                                                        |
| --------- | ------------------------------------------------------------- |
| `admin`   | Full CRUD on categories, products, and toppings               |
| `manager` | Create and update products/toppings for their own tenant only |
| Public    | Read-only access to all categories, products, and toppings    |

### Image Uploads

Product and topping create/update endpoints use **`multipart/form-data`** because they include image file uploads (max **500 KB**). The image is stored in **AWS S3** and the response contains the full public S3 URL.

> ⚠️ When sending `priceConfiguration` and `attributes` as form fields, they **must be JSON-serialised strings** (i.e., call `JSON.stringify()` on them before sending).

---

## 📁 Category Endpoints

Base path: `/categories`

A category defines the type of menu item (e.g., Pizza, Beverage, Dessert) and its pricing structure and attributes.

---

### `POST /categories`

Create a new product category.

**Auth required:** `accessToken` cookie — `admin` role only

**Request Body** (`application/json`):

```json
{
    "name": "Pizza",
    "priceConfiguration": {
        "Size": {
            "priceType": "base",
            "availableOptions": ["Small", "Medium", "Large"]
        },
        "Crust": {
            "priceType": "aditional",
            "availableOptions": ["Thin", "Thick"]
        }
    },
    "attributes": [
        {
            "name": "Wholewheat",
            "widgetType": "switch",
            "defaultValue": "No",
            "availableOptions": []
        }
    ]
}
```

| Field                | Type   | Required | Validation                                              |
| -------------------- | ------ | -------- | ------------------------------------------------------- |
| `name`               | string | ✅       | Non-empty string                                        |
| `priceConfiguration` | object | ✅       | Each key must have `priceType` of `base` or `aditional` |
| `attributes`         | array  | ✅       | Non-empty array                                         |

**`priceConfiguration` structure:**

Each key is a dimension name (e.g., `"Size"`):

| Field              | Type     | Values                                                       |
| ------------------ | -------- | ------------------------------------------------------------ |
| `priceType`        | string   | `"base"` (base price of item) or `"aditional"` (add-on cost) |
| `availableOptions` | string[] | List of option labels (e.g., `["Small", "Medium", "Large"]`) |

**`attributes` item structure:**

| Field              | Type     | Description                            |
| ------------------ | -------- | -------------------------------------- |
| `name`             | string   | Attribute label (e.g., `"Wholewheat"`) |
| `widgetType`       | string   | UI widget type: `"switch"`, `"radio"`  |
| `defaultValue`     | string   | Default selected value                 |
| `availableOptions` | string[] | Selectable options (empty for switch)  |

**Response — `200 OK`:**

```json
{ "id": "65f1a2b3c4d5e6f7a8b9c0d1" }
```

**Response — `400 Bad Request`:**

```json
{
    "errors": [{ "type": "HttpError", "message": "Category name is required" }]
}
```

**Response — `403 Forbidden`:**

```json
{
    "errors": [
        {
            "type": "ForbiddenError",
            "message": "You don't have enough permissions"
        }
    ]
}
```

---

### `GET /categories`

Retrieve all product categories.

**Auth required:** None (public)

**Query Parameters:** None

**Response — `200 OK`:**

```json
[
    {
        "_id": "65f1a2b3c4d5e6f7a8b9c0d1",
        "name": "Pizza",
        "priceConfiguration": {
            "Size": {
                "priceType": "base",
                "availableOptions": ["Small", "Medium", "Large"]
            },
            "Crust": {
                "priceType": "aditional",
                "availableOptions": ["Thin", "Thick"]
            }
        },
        "attributes": [
            {
                "name": "Wholewheat",
                "widgetType": "switch",
                "defaultValue": "No",
                "availableOptions": []
            }
        ],
        "createdAt": "2024-01-01T00:00:00.000Z",
        "updatedAt": "2024-01-01T00:00:00.000Z"
    }
]
```

---

### `GET /categories/:categoryId`

Retrieve a single category by its MongoDB ObjectId.

**Auth required:** None (public)

**Path Parameters:**

| Parameter    | Type   | Description                      |
| ------------ | ------ | -------------------------------- |
| `categoryId` | string | MongoDB ObjectId of the category |

**Response — `200 OK`:**

```json
{
    "_id": "65f1a2b3c4d5e6f7a8b9c0d1",
    "name": "Pizza",
    "priceConfiguration": {},
    "attributes": []
}
```

**Response — `404 Not Found`:**

```json
{
    "errors": [{ "type": "HttpError", "message": "Category not found" }]
}
```

---

### `PATCH /categories/:id`

Update an existing category. The `priceConfiguration` object is **deep-merged** with the existing data — you only need to send the keys you want to change.

**Auth required:** `accessToken` cookie — `admin` role only

**Path Parameters:**

| Parameter | Type   | Description                      |
| --------- | ------ | -------------------------------- |
| `id`      | string | MongoDB ObjectId of the category |

**Request Body** (`application/json`):

```json
{
    "name": "Pizza (Updated)",
    "priceConfiguration": {
        "Size": {
            "priceType": "base",
            "availableOptions": ["Small", "Medium", "Large", "XL"]
        }
    },
    "attributes": [
        {
            "name": "Wholewheat",
            "widgetType": "switch",
            "defaultValue": "No",
            "availableOptions": []
        }
    ]
}
```

**Response — `200 OK`:**

```json
{ "id": "65f1a2b3c4d5e6f7a8b9c0d1" }
```

**Response — `404 Not Found`:**

```json
{
    "errors": [{ "type": "HttpError", "message": "Category not found" }]
}
```

---

## 🍕 Product Endpoints

Base path: `/products`

Products belong to a tenant (restaurant) and a category. They include pricing configuration (mapped to category price dimensions) and attributes.

> ⚠️ **Create and Update use `multipart/form-data`.** The `priceConfiguration` and `attributes` fields must be sent as **JSON strings**.

---

### `POST /products`

Create a new product with an image.

**Auth required:** `accessToken` cookie — `admin` or `manager` role

**Body type:** `multipart/form-data`

**Form Fields:**

| Field                | Type   | Required | Description                          |
| -------------------- | ------ | -------- | ------------------------------------ |
| `name`               | string | ✅       | Product name                         |
| `description`        | string | ✅       | Product description                  |
| `tenantId`           | string | ✅       | Restaurant ID                        |
| `categoryId`         | string | ✅       | MongoDB ObjectId of the category     |
| `isPublish`          | string | ✅       | `"true"` or `"false"`                |
| `priceConfiguration` | string | ✅       | JSON-stringified price config object |
| `attributes`         | string | ✅       | JSON-stringified attributes array    |
| `image`              | file   | ✅       | Product image (max 500 KB)           |

**`priceConfiguration` JSON string example:**

```json
{
    "Size": {
        "priceType": "base",
        "availableOptions": {
            "Small": 149,
            "Medium": 199,
            "Large": 249
        }
    },
    "Crust": {
        "priceType": "aditional",
        "availableOptions": {
            "Thin": 0,
            "Thick": 30
        }
    }
}
```

> The keys must match the `priceConfiguration` dimensions defined in the category. `availableOptions` maps option labels to their prices (in ₹).

**`attributes` JSON string example:**

```json
[{ "name": "Wholewheat", "value": "No" }]
```

**Response — `200 OK`:**

```json
{ "id": "65f1a2b3c4d5e6f7a8b9c0d2" }
```

**Side effect:** Publishes a `PRODUCT_CREATE` event to the `product` Kafka topic (consumed by order-service to update its pricing cache).

**Response — `400 Bad Request` (file too large):**

```json
{
    "errors": [
        { "type": "HttpError", "message": "File size exceeds the limit" }
    ]
}
```

---

### `GET /products`

Retrieve a paginated list of products with optional filters.

**Auth required:** None (public)

**Query Parameters:**

| Parameter    | Type   | Default | Description                              |
| ------------ | ------ | ------- | ---------------------------------------- |
| `tenantId`   | string | —       | Filter by restaurant ID                  |
| `categoryId` | string | —       | Filter by category MongoDB ObjectId      |
| `isPublish`  | string | —       | `"true"` to show only published products |
| `q`          | string | —       | Search by product name                   |
| `page`       | number | `1`     | Page number                              |
| `limit`      | number | `10`    | Items per page                           |

**Example Request:**

```
GET /products?tenantId=1&isPublish=true&page=1&limit=10
```

**Response — `200 OK`:**

```json
{
    "data": [
        {
            "_id": "65f1a2b3c4d5e6f7a8b9c0d2",
            "name": "Margherita Pizza",
            "description": "Classic tomato and mozzarella pizza",
            "image": "https://catalog-service-dev.s3.ap-south-1.amazonaws.com/some-uuid",
            "tenantId": "1",
            "categoryId": "65f1a2b3c4d5e6f7a8b9c0d1",
            "isPublish": true,
            "priceConfiguration": {
                "Size": {
                    "priceType": "base",
                    "availableOptions": {
                        "Small": 149,
                        "Medium": 199,
                        "Large": 249
                    }
                }
            },
            "attributes": [{ "name": "Wholewheat", "value": "No" }]
        }
    ],
    "total": 1,
    "pageSize": 10,
    "currentPage": 1
}
```

> The `image` field contains the full S3 URL (not just the UUID key).

---

### `PUT /products/:productId`

Update an existing product. Image is optional — if no new image is uploaded, the existing one is kept.

**Auth required:** `accessToken` cookie — `admin` or `manager` role

> **Manager restriction:** Managers can only update products belonging to their own tenant.

**Path Parameters:**

| Parameter   | Type   | Description                     |
| ----------- | ------ | ------------------------------- |
| `productId` | string | MongoDB ObjectId of the product |

**Body type:** `multipart/form-data`

**Form Fields:**

| Field                | Type   | Required | Description                                               |
| -------------------- | ------ | -------- | --------------------------------------------------------- |
| `name`               | string | ✅       | Product name                                              |
| `description`        | string | ✅       | Product description                                       |
| `tenantId`           | string | ✅       | Restaurant ID                                             |
| `categoryId`         | string | ✅       | Category MongoDB ObjectId                                 |
| `isPublish`          | string | ✅       | `"true"` or `"false"`                                     |
| `priceConfiguration` | string | ✅       | JSON-stringified price config object                      |
| `attributes`         | string | ✅       | JSON-stringified attributes array                         |
| `image`              | file   | ❌       | New image (optional). If omitted, existing image is kept. |

**Response — `200 OK`:**

```json
{ "id": "65f1a2b3c4d5e6f7a8b9c0d2" }
```

**Side effect:** Publishes a `PRODUCT_UPDATE` event to the `product` Kafka topic.

**Response — `403 Forbidden` (wrong tenant):**

```json
{
    "errors": [
        {
            "type": "HttpError",
            "message": "You are not allowed to access this product"
        }
    ]
}
```

**Response — `404 Not Found`:**

```json
{
    "errors": [{ "type": "HttpError", "message": "Product not found" }]
}
```

---

## 🧅 Topping Endpoints

Base path: `/toppings`

Toppings are add-ons (e.g., Extra Cheese, Mushrooms) that belong to a tenant.

> ⚠️ **Create uses `multipart/form-data`** because it includes an image file upload.

---

### `POST /toppings`

Create a new topping with an image.

**Auth required:** `accessToken` cookie — `admin` or `manager` role

**Body type:** `multipart/form-data`

**Form Fields:**

| Field      | Type   | Required | Description                |
| ---------- | ------ | -------- | -------------------------- |
| `name`     | string | ✅       | Topping name               |
| `price`    | number | ✅       | Price in ₹ (e.g., `49`)    |
| `tenantId` | string | ✅       | Restaurant ID              |
| `image`    | file   | ✅       | Topping image (max 500 KB) |

**Response — `200 OK`:**

```json
{ "id": "65f1a2b3c4d5e6f7a8b9c0d3" }
```

**Side effect:** Publishes a `TOPPING_CREATE` event to the `topping` Kafka topic (consumed by order-service to update its topping price cache).

**Response — `400 Bad Request` (missing image):**

```json
{
    "errors": [{ "type": "HttpError", "message": "Topping image is required" }]
}
```

---

### `GET /toppings`

Retrieve all toppings for a given tenant.

**Auth required:** None (public)

**Query Parameters:**

| Parameter  | Type   | Required | Description                      |
| ---------- | ------ | -------- | -------------------------------- |
| `tenantId` | string | ✅       | Filter toppings by restaurant ID |

**Example Request:**

```
GET /toppings?tenantId=1
```

**Response — `200 OK`:**

```json
[
    {
        "id": "65f1a2b3c4d5e6f7a8b9c0d3",
        "name": "Extra Cheese",
        "price": 49,
        "tenantId": "1",
        "image": "https://catalog-service-dev.s3.ap-south-1.amazonaws.com/some-uuid"
    }
]
```

> The `image` field contains the full S3 URL.

---

## 📋 Endpoint Summary

| Method  | Endpoint                  | Auth      | Role            | Body Type             |
| ------- | ------------------------- | --------- | --------------- | --------------------- |
| `POST`  | `/categories`             | ✅ Cookie | Admin           | JSON                  |
| `GET`   | `/categories`             | ❌ Public | —               | —                     |
| `GET`   | `/categories/:categoryId` | ❌ Public | —               | —                     |
| `PATCH` | `/categories/:id`         | ✅ Cookie | Admin           | JSON                  |
| `POST`  | `/products`               | ✅ Cookie | Admin / Manager | `multipart/form-data` |
| `GET`   | `/products`               | ❌ Public | —               | —                     |
| `PUT`   | `/products/:productId`    | ✅ Cookie | Admin / Manager | `multipart/form-data` |
| `POST`  | `/toppings`               | ✅ Cookie | Admin / Manager | `multipart/form-data` |
| `GET`   | `/toppings`               | ❌ Public | —               | —                     |

---

## ⚙️ Error Response Format

```json
{
    "errors": [
        {
            "type": "HttpError | ForbiddenError | UnauthorizedError",
            "message": "Human-readable error message"
        }
    ]
}
```

| Status | Meaning                                        |
| ------ | ---------------------------------------------- |
| `400`  | Validation error, bad input, or file too large |
| `401`  | Missing or expired `accessToken` cookie        |
| `403`  | Authenticated but insufficient role            |
| `404`  | Resource not found                             |
| `500`  | Internal server error                          |

---

## 🔗 Kafka Events Published

| Event            | Topic     | Trigger             |
| ---------------- | --------- | ------------------- |
| `PRODUCT_CREATE` | `product` | New product created |
| `PRODUCT_UPDATE` | `product` | Product updated     |
| `TOPPING_CREATE` | `topping` | New topping created |

These events are consumed by the **order-service** to keep its local pricing cache up to date.
