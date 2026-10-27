// Runs training off the page's main thread so the page stays responsive.
importScripts("stats.js", "draft.js", "train.js");

onmessage = (e) => {
  const { dataset, tags } = e.data;
  try {
    const model = Train.train(dataset, tags, (progress) => postMessage({ progress }));
    postMessage({ model });
  } catch (err) {
    postMessage({ error: String(err && err.message ? err.message : err) });
  }
};
