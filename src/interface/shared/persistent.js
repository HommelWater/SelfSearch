document.addEventListener('DOMContentLoaded', connectWS);
let socket;
const functions = {};  // function_name : function


// Use this function on another function that you want to call from the server.
function persistent(fn) {
    if (typeof fn !== 'function') return fn;
    
    if (functions.hasOwnProperty(fn.name)) {
        console.warn(`Function "${fn.name}" is already registered. Skipping duplicate.`);
        return fn;
    }

    functions[fn.name] = fn;
    return fn;
}

// Use this function to send over ("call") data to the server to be executed by the given function.
async function send(fn, data){
    data["function"]  = fn;
    await socket.send(JSON.stringify(data));
}

async function onWSMessage(e){
    const data = JSON.parse(e.data);
    if (!data.function) return;
    const fn = functions[data.function];
    if (typeof fn != 'function') console.warn(`Function "${data.function}" was not found.`);
    const { function: _, ...args } = data;
    const values = Object.values(args);
    await fn(...values);
}

function connectWS(){
    if((document.visibilityState === 'visible') && (!socket || (socket.readyState !== WebSocket.OPEN))){
        if (socket) socket.close();
        socket = new WebSocket(`${window.location.origin.replace(/^http(s)?/, 'ws$1')}/persistent/ws`);
        socket.addEventListener('close', onWSClose);
        socket.addEventListener('open', onWSOpen);
        socket.addEventListener('message', onWSMessage);
    }
}

async function onWSOpen(){
    const session = localStorage.getItem("session");
    await send("open", {session});
}

function onWSClose(){
    if (document.visibilityState === 'visible') setTimeout(connectWS, 1000);
}
