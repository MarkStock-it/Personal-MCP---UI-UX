/** Run at most n async tasks at once. */
export function pLimit(n) {
    let active = 0;
    const queue = [];
    const next = () => {
        active--;
        queue.shift()?.();
    };
    return (fn) => new Promise((resolve, reject) => {
        const run = () => {
            active++;
            fn().then(resolve, reject).finally(next);
        };
        if (active < n)
            run();
        else
            queue.push(run);
    });
}
