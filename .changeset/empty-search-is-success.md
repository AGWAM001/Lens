---
'lens': patch
---

An empty `bazaar_search` result is a success, not an error (#414). A search that ran correctly and matched nothing returned `isError: true` with `ERR_NO_RESULTS`, which an agent answers by retrying or rephrasing — a paid call spent on a question already answered. It now returns the empty collection. `ERR_NO_RESULTS` is unchanged for `lens_get_price`, where a refused pair really is an error.
