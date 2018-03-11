const Bluez = require('bluez');
const bluetooth = new Bluez();

module.exports = function(RED) {
    function BluetoothNodeIn(config) {
        RED.nodes.createNode(this,config);
        var node = this;
        var context = this.context();
        context.connectedDevice = null;
		node.status({fill:"red",shape:"ring",text:"disconnected"});

        node.on('input', function(msg) {
            if (msg.topic === 'scan') {
                if(msg.payload == true) {
                    registerCallbackForNewDevicesAndSearch(node, 'hci0');   //TODO : a mettre en parametre
                } else if(msg.payload == false) {
                    cancelSearch(node);
                }
            } else if (msg.topic === 'address') {
				try {
					var address = msg.payload.split(' ')[0];
					node.debug("address received = '" + msg.payload + "', connected to '" + address + "'");
					if(address.length>0) {
						connectToDevice(node, address);
					}
				} catch(err) {
					disconnectFromDevice(node);
				}
            } else if (msg.topic === 'write' && context.connectedDevice && context.connectedDevice.socket) {
				try {
					node.debug("Will write " + msg.payload);
					context.connectedDevice.socket.write( msg.payload, 'ascii', ()=> {
						node.debug("done");
					} );
					
				} catch(err) {
					node.debug("Unable to write data. " + err);
				}
			}
        });

        node.on('close', function() {
            // tidy up any state
			disconnectFromDevice(node);
			cancelSearch(node);
			
        });
		initializeBluetoothInterface(node);
    }

    RED.nodes.registerType("bluetooth-node-in", BluetoothNodeIn);
};

async function registerCallbackForNewDevicesAndSearch(node, adapterName) {
	
	node.debug("Setting new device found callback for adapter '" + adapterName + "'.");
    bluetooth.on('device', async (address, props) => {
        try {
            const propName = props.Name || "???";
            node.debug("Found new Device '" + address + "' " + propName);
            node.send([null, null, {"topic":"address", "payload":address + " " + propName}]);
        } catch(err) {
            node.warn("Error on device '" + address + "'. " + err.message || err);
        }
    });

    var context = node.context();
    if(!context.adapter) {
		node.debug("Get adapter '" + adapterName + "'.");
        context.adapter = await bluetooth.getAdapter(adapterName);
    }
    if(!context.adapter) {
        node.warn("No bluetooth adapter '" + adapterName + "' found.");
    }
    else if(context.adapter.Discovering()!=true) {
        await context.adapter.StartDiscovery();
		node.debug("Discovering ...");
    }
}

async function cancelSearch(node) {
    try {
        var context = node.context();
        if(context.adapter) {
            await context.adapter.StopDiscovery();
            node.debug("Discovery stopped");
        }
    } catch(err) {
        node.warn("Error while stopping discovery. " + err.message || err);
    }
}

function setConnectedTo(node, device, name, socket) {
    var context = node.context();
    context.connectedDevice = device;
    if(name) {
        node.send([ { "topic":"connexion", "connected":true, "device":name, "socket":socket}, null, null]);
        node.status({fill:"green",shape:"dot",text:"connected"});
    } else{
        node.send([{ "topic":"connexion", "connected":false, "device":null, "socket":null}, null, null]);
        node.status({fill:"red",shape:"ring",text:"disconnected"});
    }
}

async function connectToDevice(node, address) {
    try {
        var context = node.context();
        if(context.connectedDevice) {
            return;
        }

        // Get the device interface
        const device = await bluetooth.getDevice(address);
        const name = await device.Name();
        node.debug("Device " + address + " " + name);

        // Pair with the device if not already done
        // Not pairing twice will throw an error
        if(!device.Paired()) {
            await device.Pair().catch((err)=>{
                node.warn("Error while pairing to device " + address + ": " + err.message);
                throw err;
            });
        }
        // Connect to the Serial Service
        await device.ConnectProfile(Bluez.SerialProfile.uuid);

    } catch(err) {
        node.warn("Error on connecting device " + address + ". " + err.message || err);
    }
}

async function disconnectFromDevice(node) {
    try {
        var context = node.context();
        if(! context.connectedDevice) {
            return;
        }
		node.debug("Disconnecting from device");
		context.connectedDevice.socket.on('data', (data)=>{});
		await context.connectedDevice.Disconnect();
		node.debug("Disconnected");
		setConnectedTo(node);
    } catch(err) {
        node.warn("Error on connecting device " + address + ". " + err.message || err);
    }
}

function initializeBluetoothInterface(node) {
    bluetooth.init().then(async ()=>{
        // listen on first bluetooth adapter
        try {
            // Register Agent that accepts everything and uses key 1234
            await bluetooth.registerDefaultAgent();
            node.debug("Agent registered");

            await bluetooth.registerSerialProfile( async (device, socket) => {
                const name = await device.Name();
                node.debug("Serial Connection from " + name);
                // socket is a non blocking duplex stream similar to net.Socket
                socket.on('data', (data)=>{
                    node.send([null, {"payload":data}, null]);
                });
                socket.on('error', (err)=>{
					node.warn(err);
                    setConnectedTo(node);
                });
                socket.on('close', (had_error)=>{
					if(had_error===true) node.warn("Closing socket with error for device " + name);
					else node.debug("Closing socket from device " + name);
                    setConnectedTo(node);
                });
				device.socket = socket;
                setConnectedTo(node, device, name, socket);

            }, "client");
        } catch(err) {
            console.log("Error on discovering " + err.message || err);
        }
    });
}
