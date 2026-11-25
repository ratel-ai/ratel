/** A console module may hash on the server in a file whose labels a view draws. A view never hashes. */
function absent(): never {
  throw new Error("node:crypto is not in a view");
}

export const createHash = absent;
export const randomUUID = absent;
