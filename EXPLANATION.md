# catelog-service — code walkthrough

How this service is put together, file by file and function by function.

This is the **internals** document. For the request/response contract an API
consumer needs — payload shapes, example bodies, status codes — see
[API-DOCS.md](./API-DOCS.md). This one explains *why the code looks the way it
does*, which is the part that is hard to recover from reading it cold.

The service name is misspelled ("catelog") in the directory and repo; the
package name, the Kafka client id and the log `serviceName` all say
"catalog-service". Both spellings appear below wherever they appear in code.

---

## 1. What this service owns

catelog-service owns **the menu**: what a restaurant sells, how it is priced,
and what a customer may configure about it.

| Responsibility | Detail |
| --- | --- |
| Categories | Pizza, Beverages… platform-wide, admin-only, defines the *shape* of pricing |
| Products | A concrete sellable item belonging to one tenant and one category |
| Toppings | Per-tenant add-ons with a flat price |
| Product images | Uploaded to S3, stored as a bare uuid, rebuilt into a URL on read |
| Price broadcasting | Publishes price configuration to Kafka so order-service can price a cart offline |

Two things it deliberately does **not** own:

- **Identity.** It never issues a token. It fetches auth-service's public key
  from `/.well-known/jwks.json` and validates RS256 access tokens locally, so
  auth-service being down does not stop a customer browsing a menu.
- **Order pricing.** It publishes prices; order-service caches them and does
  the arithmetic. Checkout therefore does not call this service at all.

### The category/product split, which is the central idea

A **category** does not hold prices. It holds a *price configuration schema* —
the dimensions along which anything in that category is priced:

```jsonc
// Category "Pizza"
{
  "priceConfiguration": {
    "Size":  { "priceType": "base",      "availableOptions": ["Small", "Medium", "Large"] },
    "Crust": { "priceType": "aditional", "availableOptions": ["Thin", "Thick"] }
  },
  "attributes": [
    { "name": "isHit", "widgetType": "radio", "defaultValue": "No", "availableOptions": ["Yes", "No"] }
  ]
}
```

A **product** fills those same keys in with numbers:

```jsonc
// Product "Margherita"
{
  "priceConfiguration": {
    "Size":  { "priceType": "base",      "availableOptions": { "Small": 400, "Medium": 600, "Large": 800 } },
    "Crust": { "priceType": "aditional", "availableOptions": { "Thin": 0, "Thick": 50 } }
  }
}
```

Note the type change: `availableOptions` is `[String]` on a category and
`Map<String, Number>` on a product. Same key names, different meaning — the
category says *which options exist*, the product says *what each costs*. This
is why both schemas use `type: Map` rather than fixed fields: a new pricing
dimension ("Sauce") is a data change, not a migration.

`priceType` splits the arithmetic. `base` options replace each other (you pick
one size); `aditional` options add on top. The misspelling `aditional` is
load-bearing — it is in the Mongoose `enum`, in both validators, and in stored
documents. Fixing it needs a data migration and a coordinated change in
order-service.

---

## 2. The shape of a request

```
HTTP request
    │
    ├─ app.ts             cors → express.json → cookieParser
    │
    ├─ */-router.ts       matches the path, assembles the middleware chain,
    │                     and holds all the dependency wiring
    │
    ├─ middlewares         authenticate → canAccess → fileUpload → validator
    │                      (each may end the request early)
    │
    ├─ asyncWrapper        catches a rejected controller promise
    │
    ├─ */-controller.ts    reads req, calls the service, publishes to Kafka,
    │                      shapes the response
    │
    ├─ */-service.ts       owns the Mongoose model and all query construction
    │
    └─ globalErrorHandler  catches anything passed to next(err)
```

Two deviations from auth-service worth knowing before you read further:

1. **There is no repository layer.** The `*-service` classes import the
   Mongoose model directly. Mongoose models already are a repository, so the
   extra indirection auth-service needs for TypeORM buys nothing here.
2. **Controllers publish to Kafka themselves.** `ProductController` and
   `ToppingController` both build the event payload and call
   `broker.sendMessage` inline. This means the write and the publish are not
   in a transaction — see [§10](#10-known-issues).

---

## 3. Bootstrapping

### `src/server.ts`

The entry point. Order matters here:

```ts
if (process.env.NODE_ENV !== "production") {
    dns.setServers(["8.8.8.8", "8.8.4.4"]);
}
```

A local workaround: MongoDB Atlas `mongodb+srv://` URLs need an SRV DNS lookup,
and some ISP resolvers do not answer them. Forcing Google's resolvers fixes
local development. It is guarded to non-production on purpose — overriding the
resolver process-wide on a hosted environment breaks resolution of private
internal hostnames, which is a much worse failure than a slow lookup.

Then `startServer()`:

1. `await initDb()` — connect Mongoose, fail fast if the database is unreachable
2. `createMessageProducerBroker()` then `await connect()` — connect the Kafka producer
3. `app.listen(PORT)`

On any error it disconnects the broker if it got that far, logs, and waits for
winston's `finish` event before `process.exit(1)` — otherwise the process can
die before the log line is flushed to disk.

The service will **not** start if Kafka is unreachable. That is a deliberate
trade (a running catalog that silently stops publishing price updates is worse
than one that fails loudly) but it does mean Kafka is a hard startup dependency.

### `src/app.ts`

Small, and does only four things:

```ts
const ALLOWED_DOMAINS = [config.get("frontend.clientUI"), config.get("frontend.adminUI")];
app.use(cors({ origin: ALLOWED_DOMAINS as string[], credentials: true }));
app.use(express.json());
app.use(cookieParser());
```

`credentials: true` is required, not cosmetic: the access token arrives as an
httpOnly cookie, and the browser will not send it cross-origin without this.
The origin list is a literal allowlist of two — not a wildcard — because
`credentials: true` and `origin: "*"` are mutually exclusive in the CORS spec.

`cookieParser()` must run before any route, because `authenticate`'s `getToken`
reads `req.cookies.accessToken`.

Then `GET /` (a health check returning `{ message: "Hello from catalog
service!" }`), the three routers, and `globalErrorHandler` last.

There is **no `express-fileupload` at app level** — it is mounted per-route, in
the two routes that accept an upload. That keeps the multipart parser off every
JSON endpoint.

### `src/config/db.ts`

```ts
export const initDb = async () => { await mongoose.connect(config.get("database.url")); };
```

That is the whole file. Mongoose manages its own connection pool and buffers
queries until connected, so nothing else needs to know about connection state.

### `src/config/logger.ts`

Three winston transports — `logs/combined.log`, `logs/error.log`, and the
console — all with `silent: process.env.NODE_ENV === "test"`, which is what
keeps the test output readable. `defaultMeta.serviceName` is `"catalog-service"`,
which is how you tell these lines apart in aggregated logs.

### `src/config/kafka.ts` — `KafkaProducerBroker`

Implements `MessageProducerBroker`. The constructor branches on environment:

```ts
if (process.env.NODE_ENV === "production") {
    kafkaConfig = { ...kafkaConfig, ssl: config.get("kafka.ssl"), connectionTimeout: 45000,
                    sasl: { mechanism: "plain", username: ..., password: ... } };
}
```

Local Kafka runs plaintext with no auth; a managed broker (Upstash, Confluent)
needs SASL/PLAIN over TLS and is slow to hand out a connection, hence the 45s
timeout. This is also why `config/production.yaml` must define `kafka.ssl` even
though the value gets overridden from the environment — node-config **throws**
on `get()` of an undefined key, so the key has to exist.

- `connect()` / `disconnect()` — thin passthroughs; `disconnect` null-guards
  the producer so a failed startup can still clean up.
- `sendMessage(topic, message)` — `producer.send({ topic, messages: [{ value: message }] })`.
  No key is set, so messages round-robin across partitions and **ordering is
  not guaranteed** for a given product. See [§10](#10-known-issues).

### `src/common/factories/brokerFactory.ts`

```ts
let messageProducer: MessageProducerBroker | null = null;
export const createMessageProducerBroker = (): MessageProducerBroker => {
    if (!messageProducer) messageProducer = new KafkaProducerBroker("catalog-service", config.get("kafka.broker"));
    return messageProducer;
};
```

A module-level singleton. Both `product-router.ts` and `topping-router.ts` call
it at import time, and `server.ts` calls it again — all three get the same
producer, so `connect()` is called once on the instance the routers already
hold. Without the singleton the routers would hold unconnected producers and
every publish would throw.

The consequence for tests: because the routers call this **at module load**,
the factory has to be mocked *before* `src/app` is imported. Every spec that
imports the app does:

```ts
jest.mock("../../src/common/factories/brokerFactory", () => require("../mocks/broker"));
```

---

## 4. The data layer

There is no repository class. Each domain has a `*-service.ts` that owns its
model, and a `*-model.ts` that defines the schema.

### `category-model.ts`

Three schemas. `priceConfigurationSchema` and `attributeSchema` both use
`{ _id: false }` — they are embedded value objects, not documents, and letting
Mongoose stamp an `_id` on each would leak into every API response.

`categorySchema.priceConfiguration` is `{ type: Map, of: priceConfigurationSchema }`.
Using a Map rather than an object is what allows arbitrary keys with a
*validated* value shape: any key name is fine, but every value must have a
`priceType` in the enum and a `[String]` of options.

Note what is **absent**: no `tenantId`, no unique index on `name`. Categories
are platform-wide (which is why only an admin may create one), and duplicate
names are permitted.

### `product-model.ts`

`priceConfiguration` is again `type: Map`, but `of` a schema whose
`availableOptions` is itself `{ type: Map, of: Number }` — a nested Map, which
is exactly why `mapToObject` (§5) has to recurse.

`categoryId` is a real `ObjectId` ref to `Category`; `tenantId` is a plain
`String`, because tenants live in auth-service's Postgres and cannot be
referenced. `isPublish` defaults to `false`, so a newly created product is
invisible to the storefront until explicitly published. `{ timestamps: true }`
adds `createdAt`/`updatedAt`.

The last line is the important one:

```ts
productSchema.plugin(aggregatePaginate);
export default mongoose.model<Product, AggregatePaginateModel<Product>>("Product", productSchema);
```

The plugin adds `Model.aggregatePaginate()`, and the second type parameter is
what makes TypeScript aware of it. Products are the only collection paginated
this way because they are the only one joined to another collection — the
listing needs `$lookup`, so it needs *aggregate* pagination rather than plain
`find().skip().limit()`.

### `topping-model.ts`

Flat: `name`, `price: Number`, `image`, `tenantId`, all required, with
timestamps. No pagination plugin — `ToppingService.getAll` carries a
`todo: !Important, add pagination`, and it is a real one.

### `CategoryService`

| Method | Body | Notes |
| --- | --- | --- |
| `create(category)` | `new CategoryModel(category).save()` | `new` + `save()` rather than `create()`, which runs the same validators; the difference is stylistic |
| `getAll()` | `CategoryModel.find()` | Unfiltered and unpaginated. Fine while categories number in the dozens |
| `getOne(categoryId)` | `findOne({ _id: categoryId })` | Returns `null` if absent; **throws a CastError** if the id is not a valid ObjectId |
| `update(categoryId, updateData)` | `findByIdAndUpdate(id, { $set }, { new: true })` | `{ new: true }` returns the *post*-update document |

### `ProductService`

| Method | Body |
| --- | --- |
| `createProduct(product)` | `productModel.create(product)` |
| `updateProduct(productId, product)` | `findOneAndUpdate({ _id }, { $set: product }, { new: true })` |
| `getProduct(productId)` | `findOne({ _id: productId })` — used by `update` for the ownership check |

#### `getProducts(q, filters, paginateQuery)`

The only non-trivial query in the service. It builds an aggregation:

```ts
const searchQueryRegexp = new RegExp(q, "i");
const matchQuery = { ...filters, name: searchQueryRegexp };
```

`$match` on the filters plus a case-insensitive name regex. Two things follow
from this: the regex is **unanchored**, so it is a substring search and cannot
use an index; and `q` goes into `RegExp` unescaped, so a caller sending
`q=(((` gets a 500 and one sending a pathological pattern can pin a CPU.

Then `$lookup` into `categories` with an inner `$project` (only `_id`, `name`,
`attributes`, `priceConfiguration` — the client needs the category's schema to
render the configurator, not the whole document), and `$unwind: "$category"` to
flatten the single-element array into an object.

`$unwind` without `preserveNullAndEmptyArrays` **drops** any product whose
category was deleted. That is arguably right for a storefront, but it interacts
badly with the paginate count — see [§10](#10-known-issues).

Finally:

```ts
return productModel.aggregatePaginate(aggregate, { ...paginateQuery, customLabels: paginationLabels });
```

### `src/config/pagination.ts`

```ts
export const paginationLabels = { totalDocs: "total", docs: "data", limit: "pageSize", page: "currentPage" };
```

This renames the plugin's output fields. It is small and easy to skim past, but
it is the direct cause of one of the bugs in §10: after the rename the result
object has `pageSize` and `currentPage`, and the controller still reads
`.limit` and `.page`.

### `ToppingService`

`create(topping)` → `toppingModel.create(topping)`.
`getAll(tenantId)` → `toppingModel.find({ tenantId })`. No pagination, and no
projection — the full document goes to the controller, which reshapes it.

---

## 5. Shared utilities

### `src/utils.ts` — `mapToObject(map)`

```ts
export function mapToObject(map: Map<string, any>) {
    const obj = {};
    for (const [key, value] of map) obj[key] = value instanceof Map ? mapToObject(value) : value;
    return obj;
}
```

Nine lines, and load-bearing. `JSON.stringify(new Map())` produces `{}` — Maps
serialize to nothing. Since `priceConfiguration` is a Map of Maps, publishing a
product event without this would send order-service an empty price
configuration, and every order would price at zero. The recursion exists
specifically because `availableOptions` is a nested Map.

The two suppressions (`// todo: fix this type error`, `// @ts-ignore`) are
there because `obj` is typed `{}` and gets indexed by string.

### `src/common/utils/wrapper.ts` — `asyncWrapper(handler)`

```ts
Promise.resolve(requestHandler(req, res, next)).catch((err) => {
    if (err instanceof Error) return next(createHttpError(500, err.message));
    return next(createHttpError(500, "Internal server error"));
});
```

Every route is wrapped in this. Two behaviours worth being precise about:

- It **flattens the status**. An error that already carried 404 or 403 arrives
  at `globalErrorHandler` as a 500 — but only if it was *thrown*. The
  controllers pass their `createHttpError(404, …)` to `next()` directly rather
  than throwing, which bypasses the wrapper entirely and preserves the status.
  So the flattening only bites errors that escape as rejections.
- It does **not** catch synchronous throws. `Promise.resolve(fn())` only wraps
  the return value; if `fn` throws before returning, the exception propagates
  out of the wrapper. Express 5 happens to catch it downstream, which is why
  this has never been visible.

### `src/common/services/S3Storage.ts`

Implements `FileStorage` (`upload` / `delete` / `getObjectUri`). The client is
built in the constructor from `s3.region`, `s3.accessKeyId`, `s3.secretAccessKey`.

- `upload({ filename, fileData })` — `PutObjectCommand` with
  `Bucket: config.get("s3.bucket")`, `Key: filename`, `Body: fileData`.
- `delete(filename)` — the matching `DeleteObjectCommand`.
- `getObjectUri(filename)` — string-builds
  `https://{bucket}.s3.{region}.amazonaws.com/{filename}`, and throws a 500
  `"Invalid S3 configuration"` if either config value is not a string.

The design decision: **only the uuid is persisted.** The URL is rebuilt on
every read. That means moving buckets or regions is a config change with no
data migration — but it also means a missing `S3_BUCKET` makes every *listing*
throw while uploads keep succeeding, which looks like a broken catalog and a
healthy storage layer.

---

## 6. Middlewares

### `authenticate` — is this a valid access token?

`express-jwt` configured with `jwks-rsa`:

```ts
secret: jwksClient.expressJwtSecret({ jwksUri: config.get<string>("auth.jwksUri"), cache: true, rateLimit: true }),
algorithms: ["RS256"],
```

`algorithms: ["RS256"]` is a security control, not a hint — without it, a
forged token with `alg: none` or a symmetric `alg: HS256` (signed with the
*public* key, which is public) would be accepted. `cache: true` means the
signing key is fetched once, not per request; `rateLimit: true` caps fetches
when a key rotation causes misses.

`getToken` prefers the `Authorization: Bearer` header and falls back to the
`accessToken` cookie. The odd-looking guard:

```ts
if (authHeader && authHeader.split(" ")[1] !== "undefined") { ... }
```

is checking for the literal **string** `"undefined"` — the result of a client
doing `` `Bearer ${someUndefinedVar}` ``. Without it, that string would be
treated as a token, fail verification, and 401 even though a perfectly good
cookie was also present.

On failure `express-jwt` produces an `UnauthorizedError` with `status: 401`,
which reaches `globalErrorHandler`.

### `canAccess(roles)` — is this token allowed here?

```ts
const roleFromToken = (req as AuthRequest).auth.role;
if (!roles.includes(roleFromToken)) return next(createHttpError(403, "You don't have enough permissions"));
```

It reads `req.auth`, which only exists because `authenticate` ran first. Order
in the chain is not optional: `canAccess` before `authenticate` throws a
TypeError on `undefined.role`.

It checks the role and nothing else. **Tenant ownership is not checked here** —
that lives in `ProductController.update`, and only there.

### `globalErrorHandler`

Mounted last. Assigns a `uuid` reference id, logs the full stack with the
request path and method, and responds:

```jsonc
{ "errors": [{ "ref": "<uuid>", "type": err.name, "msg": "...", "path": req.path,
               "location": "server", "stack": "..." }] }
```

`err.status || 500`, and in production both the message and the stack are
suppressed — `msg` becomes `"An unexpected error occurred."` and `stack` becomes
`null`. The `ref` uuid is the bridge: the client sees an opaque id, the log has
that id next to the real error.

This differs from auth-service, which echoes the real message for a 400 and
masks everything else. Here **every** status is masked in production, so a
client gets `"An unexpected error occurred."` for a plain validation failure —
not much to act on. `tests/common/global-error-handler.spec.ts` pins this
difference down deliberately.

---

## 7. Validators

All four are plain `express-validator` chain arrays. **A validator array only
records failures onto the request** — it never ends it. The controller must
call `validationResult(req)` for the validation to have any effect. Three of
the four controllers do; `ToppingController` does not, which is why its
validator has no effect at all (§10).

The house pattern in every controller that does check:

```ts
const result = validationResult(req);
if (!result.isEmpty()) return next(createHttpError(400, result.array()[0].msg as string));
```

Only the **first** error is reported, so a request with three missing fields
gets fixed one round trip at a time.

### `category-validator.ts` (create)

`name` exists + isString; `priceConfiguration` exists; `priceConfiguration.*.priceType`
exists and is one of `["base", "aditional"]`; `attributes` exists.

The wildcard `priceConfiguration.*.priceType` is what makes this work against
arbitrary keys — it applies to `Size`, `Crust`, and anything else without
naming them. Note that `availableOptions` is *not* validated on create.

### `category-update-validator.ts`

Much stricter than the create validator, and the asymmetry is not intentional
design — the update path was simply written later.

- `param("id")` must be a valid Mongo id — the only route in the service that
  checks this
- `body().custom(...)` rejects an empty body with "At least one field must be
  provided for update"
- every field is `.optional()`, then fully validated if present, including
  `availableOptions` being an array of non-empty strings and `widgetType` being
  in `["switch", "radio"]`

Every custom validator here **throws** on failure. That matters: express-validator
treats a custom validator as failed only if it throws or returns a rejected
promise. Returning `false` from an `async` function resolves, and therefore
passes silently — the exact bug present in auth-service's update-user validator.
These are all synchronous and all throw, so they are correct.

### `create-product-validator.ts`

`name` (string), `description`, `priceConfiguration`, `attributes`, `tenantId`,
`categoryId` — all just `.exists()`. The image rule is **commented out** behind
a `todo: uncomment this line`, which is why a product POST with no file 500s
instead of 400ing.

Because the request is multipart, `priceConfiguration` and `attributes` arrive
as JSON *strings*; `.exists()` is all that can be checked here, and the actual
`JSON.parse` happens unguarded in the controller.

### `update-product-validator.ts`

The same six rules, minus the commented-out image block. It does **not**
validate `param("productId")` as a Mongo id, so a malformed id 500s.

### `create-topping-validator.ts`

`name` (string), `price`, `tenantId`, and — unlike the product validator — an
image rule that is actually present and throws "Topping image is required".
None of it runs, because the controller never reads the result.

---

## 8. Routes, one by one

### `/categories`

Wired in `category-router.ts`: one `CategoryService`, one `CategoryController`,
the shared `logger`. The controller binds all four methods in its constructor
(`this.create = this.create.bind(this)`) because they are passed as bare
function references into `asyncWrapper` and would otherwise lose `this`. The
product and topping controllers solve the same problem differently, with arrow
properties.

#### `POST /categories` → `CategoryController.create`

Chain: `authenticate` → `canAccess([ADMIN])` → `categoryValidator` → `asyncWrapper(create)`

**Admin only** — a manager is scoped to one restaurant, and a category is
platform-wide. Validates, destructures `{ name, priceConfiguration, attributes }`
(so any other field in the body is silently ignored), saves, logs, and returns
`{ id }` only — not the document.

#### `PATCH /categories/:id` → `CategoryController.update`

Chain: `authenticate` → `canAccess([ADMIN])` → `categoryUpdateValidator` → `asyncWrapper(update)`

Validates, then fetches the existing category and 404s if absent. The
interesting part is the merge:

```ts
const existingConfig = existingCategory.priceConfiguration instanceof Map
    ? Object.fromEntries(existingCategory.priceConfiguration)
    : existingCategory.priceConfiguration;
const mergedConfig = { ...existingConfig, ...updateData.priceConfiguration };
```

Mongoose hands back a real `Map`, which spreads to `{}` — hence the
`Object.fromEntries` conversion before spreading. Without it, sending a
`priceConfiguration` containing only `Crust` would **erase** `Size`.

The merge is one level deep. Sending `{ Size: { priceType: "base" } }` replaces
the whole `Size` entry, dropping its `availableOptions`. Note also that
`attributes` gets no such treatment — it is `$set` wholesale, so a partial
attributes array replaces the entire list.

Returns `{ id }`.

#### `GET /categories` → `CategoryController.index`

**Public.** No `authenticate`, because the storefront renders the menu before
anyone logs in. Returns the full array of categories, unpaginated. (A commented
out `sleep(5000)` sits at the top — a leftover loading-state test.)

#### `GET /categories/:categoryId` → `CategoryController.getOne`

**Public.** Fetches, 404s if absent, returns the document. No `isMongoId` check
on the param, so a malformed id becomes a Mongoose CastError and a 500 rather
than a 400.

### `/products`

`product-router.ts` wires a `ProductService`, a real `S3Storage`, and the
singleton broker into `ProductController`. Both write routes mount
`express-fileupload` inline with `limits: { fileSize: 500 * 1024 }`,
`abortOnLimit: true`, and a `limitHandler` that produces a 400 "File size
exceeds the limit". The limit exists because the payload is base64'd into
memory before reaching S3.

#### `POST /products` → `ProductController.create`

Chain: `authenticate` → `canAccess([ADMIN, MANAGER])` → `fileUpload` → `createProductValidator` → `asyncWrapper(create)`

1. `validationResult` → 400 on the first failure
2. `req.files!.image`, generate `uuidv4()` as the filename
3. **upload to S3 first**, then write the document — so a failed DB write
   leaves an orphaned object in the bucket rather than a product row pointing
   at nothing. The trade is deliberate; the orphan is invisible, the dangling
   reference would not be.
4. `JSON.parse` both `priceConfiguration` and `attributes` — unguarded, so
   malformed JSON is a 500
5. Save, then publish to the `product` topic:

```jsonc
{ "event_type": "PRODUCT_CREATE", "data": { "id": ..., "priceConfiguration": { ...flattened... } } }
```

`mapToObject` is what makes `priceConfiguration` survive `JSON.stringify`.
order-service consumes this to keep its price cache warm — which is what lets
checkout price an order without calling this service.

6. Returns `{ id }`.

The generated uuid, not the client filename, is the stored key — so two tenants
uploading `pizza.png` cannot collide.

Note `tenantId` comes from the **body**, not the token. A manager can create a
product for a tenant they do not belong to. The ownership check exists on
update but not on create.

#### `PUT /products/:productId` → `ProductController.update`

Chain: identical, with `updateProductValidator`.

1. `validationResult` → 400
2. Fetch the product, 404 if absent
3. **The ownership check** — the only one in the service:

```ts
if (auth.role !== Roles.ADMIN && product.tenantId !== auth.tenant)
    return next(createHttpError(403, "You are not allowed to access this product"));
```

An admin may edit anything; a manager may only edit their own tenant's
products. This is why `tenant` is a claim in the access token.

4. If a new image was sent: upload the new one, **then** delete the old one.
   That order means a failure between the two leaves an orphan rather than a
   product pointing at a deleted object. If no image was sent, `oldImage` is
   carried forward.
5. `$set` the whole document (so this is a full replace — every field in the
   validator is required, and `PUT` is honest about that), publish
   `PRODUCT_UPDATE`, return `{ id: productId }`.

No `isMongoId` on the param, so a malformed id 500s before the 404 can happen.

#### `GET /products` → `ProductController.index`

**Public.** Builds `Filter` from the query string:

- `isPublish === "true"` → `filters.isPublish = true`. Note the strict string
  comparison: there is no way to ask for *unpublished* products, and omitting
  the param returns both.
- `tenantId` → passed through as a string
- `categoryId` → converted to `ObjectId`, but **only if `isValid`** — an invalid
  id is silently dropped rather than erroring, so a typo'd category returns the
  whole catalog
- `page`/`limit` parsed from the query, defaulting to 1 and 10

Then each returned product's bare-uuid `image` is replaced with a full S3 URL
via `getObjectUri`, and the response is assembled as
`{ data, total, pageSize, currentPage }`.

Two defects live in that last line — see [§10](#10-known-issues).

### `/toppings`

`topping-router.ts` wires `S3Storage`, `ToppingService` and the broker into
`ToppingController`. Unlike the other two, this controller wraps its bodies in
`try/catch` and calls `next(err)` itself — so `asyncWrapper` around it is
redundant, though harmless.

#### `POST /toppings` → `ToppingController.create`

Chain: `authenticate` → `canAccess([ADMIN, MANAGER])` → `fileUpload` → `createToppingValidator` → `asyncWrapper(create)`

Upload the image under a fresh uuid, save `{ ...req.body, image: fileUuid,
tenantId: req.body.tenantId }`, publish `TOPPING_CREATE` to the `topping` topic
with `{ id, price, tenantId }`, return `{ id }`.

**It never calls `validationResult`.** The validator in the chain has no effect
whatsoever: an invalid request reaches `req.files!.image`, throws, and 500s —
after the image has already been uploaded.

#### `GET /toppings` → `ToppingController.get`

**Public.** `getAll(req.query.tenantId)`, then reshapes each document to
`{ id, name, price, tenantId, image: getObjectUri(topping.image) }` — note `id`,
not `_id`, and the internal timestamps are dropped.

Omitting `tenantId` queries `{ tenantId: undefined }`, which Mongoose matches
against null — so it returns `[]` rather than leaking every tenant's toppings.
Safe, but by accident rather than by a check.

---

## 9. Configuration

`node-config` with YAML, layered `default.yaml` → `{NODE_ENV}.yaml` →
`custom-environment-variables.yaml`. `NODE_ENV` is set by `cross-env` in the
npm scripts.

| Key | Env var | Notes |
| --- | --- | --- |
| `server.port` | `PORT` | 5502 |
| `database.url` | `DB_URL` | |
| `kafka.broker` | `KAFKA_BROKER` | `__format: "json"` — the env var must be a JSON array |
| `kafka.sasl.username` / `.password` | `KAFKA_SASL_*` | production only |
| `kafka.ssl` | — | not overridable; must exist in `production.yaml` or `get()` throws |
| `frontend.clientUI` / `.adminUI` | `CLIENT_UI_DOMAIN` / `ADMIN_UI_DOMAIN` | the CORS allowlist |
| `auth.jwksUri` | `JWKS_URI` | auth-service's `/.well-known/jwks.json` |
| `s3.*` | `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | |

Every value in `production.yaml` is intentionally empty and filled from the
environment at runtime.

**The `config` version is pinned to `^4.4.2` on purpose.** `config@5` ships an
ESM-only implementation behind a CJS entry that `require`s a `.mjs` file. It
cannot be loaded by Jest's CommonJS runtime at all, and its declared engine
(`>=20.11.0`) is wrong — `require(esm)` was not unflagged until Node 22.12,
while `.nvmrc` here pins 18.17.1. v4.4.2 is the last CJS-native release and has
the same API. **order-service, ws-service and notification-service are all
still on `config@5` and carry the same exposure.**

---

## 10. Known issues

Each of these is captured by a test that asserts the *current* behaviour, with
a comment naming the fix. None has been silently corrected — changing any of
them changes runtime behaviour.

**`ToppingController.create` never calls `validationResult`.**
`create-topping-validator` is decorative. Every invalid request 500s instead of
400ing, with no indication of which field was wrong, and the image is uploaded
*before* the failure, orphaning an object in the bucket. The fix is the same
four lines that sit at the top of `ProductController.create`.

**`GET /products` drops `pageSize` and `currentPage`.**
`paginationLabels` renames `limit` → `pageSize` and `page` → `currentPage` on
the result object, but the controller still reads `products.limit` and
`products.page`. Both are `undefined` and `res.json` omits them, so the client
cannot tell how many pages exist.

**`GET /products` `total` counts documents it does not return.**
The `$unwind` drops products whose category was deleted, but
`aggregatePaginate`'s count pipeline does not include the `$lookup`/`$unwind`.
A product with an orphaned category inflates `total` while being absent from
`data` — verified directly: two products, one orphaned, gives
`{ data: [1 item], total: 2 }`.

**The product image validator is commented out.**
`POST /products` with no file reaches `req.files!.image` with `req.files` null
and 500s. Uncommenting the block in `create-product-validator.ts` turns it into
a 400.

**Two routes accept a malformed id and 500.**
`GET /categories/:categoryId` and `PUT /products/:productId` have no `isMongoId`
check, so a bad id becomes a Mongoose CastError. `PATCH /categories/:id` does
have the check and 400s correctly — it is the model to copy.

**`asyncWrapper` flattens carried statuses and misses synchronous throws.**
Described in §5. Currently invisible because the controllers `next()` their
errors rather than throwing them, but it will bite the first handler that throws
an `HttpError`.

**The write and the Kafka publish are not atomic.**
If `sendMessage` fails after `createProduct` succeeded, the product exists in
Mongo and order-service never learns its price. The transactional-outbox fix is
real work; the cheap mitigation is at least logging the divergence.

**Kafka messages carry no key.**
`producer.send` sets only `value`, so events round-robin across partitions and
two rapid updates to the same product can be consumed out of order. Setting
`key: productId` would pin a product's events to one partition and restore
ordering.

**`config/development.yaml` contains live credentials.**
A real Atlas connection string with its password, and a real AWS access key and
secret, are committed in plaintext. These should be treated as compromised and
rotated, and the file should read from the environment like `production.yaml`
does.

**`GET /products` builds a `RegExp` from unescaped user input.**
`new RegExp(q, "i")` — `q=(((` is a 500, and a pathological pattern is a CPU
sink. Escaping the input, or switching to a text index, fixes both. The regex is
also unanchored and therefore cannot use an index.

**`POST /products` trusts `tenantId` from the body.**
A manager can create a product under any tenant. `PUT` checks ownership;
`POST` does not.

**No pagination on toppings or categories.**
`ToppingService.getAll` carries its own `todo: !Important`. Both return
everything.

---

## 11. Where the tests live

164 tests across 14 suites, run against a local MongoDB. `jest --runInBand`,
because every spec drops and recreates the same database.

```
tests/app.spec.ts                    health check, 404s, malformed JSON, CORS allowlist
tests/category/create.spec.ts        POST /categories — Map storage, validation, admin-only
tests/category/update.spec.ts        PATCH — the merge semantics, 404, param validation
tests/category/read.spec.ts          GET list and GET one, public access
tests/product/create.spec.ts         POST — S3 upload, uuid naming, Kafka event, roles
tests/product/update.spec.ts         PUT — tenant ownership, image replacement, events
tests/product/list.spec.ts           GET — filters, search, pagination (incl. the two defects)
tests/topping/create.spec.ts         POST — captures the missing validationResult
tests/topping/list.spec.ts           GET — reshaping, tenant scoping
tests/common/wrapper.spec.ts         asyncWrapper, including what it does not catch
tests/common/can-access.spec.ts      role gating
tests/common/global-error-handler.spec.ts   envelope, ref ids, production masking
tests/common/s3-storage.spec.ts      what S3Storage asks the SDK to do
tests/common/map-to-object.spec.ts   nested Map flattening
tests/mocks/s3.ts                    replaces S3Storage; records uploads
tests/mocks/broker.ts                replaces the broker factory; records published messages
tests/utils/db.ts                    connect / clear / disconnect
tests/utils/fixtures.ts              category, product and topping payload builders
```

Two harness details that are not obvious:

**Mocks must be registered before `src/app` is imported.** The routers construct
an `S3Storage` and call `createMessageProducerBroker()` at module load, so both
`jest.mock` calls sit above the `import app` line. The factory form
`() => require("../mocks/s3")` is used rather than referencing a top-level
`const`, because `jest.mock` is hoisted above `const` declarations and would hit
a temporal-dead-zone error.

**`mock-jwks` stands up a fake JWKS endpoint** at `http://localhost:5501` —
the same URL `config.get("auth.jwksUri")` points at in `test.yaml` — so specs
can mint access tokens that `authenticate` genuinely verifies. Nothing is
stubbed out of the auth path; the signature check really runs.
