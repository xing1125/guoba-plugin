import{dL as baseUniq,dI as baseIteratee}from"./index.js";function uniqBy(array,iteratee){return array&&array.length?baseUniq(array,baseIteratee(iteratee)):[]}export{uniqBy as u};
