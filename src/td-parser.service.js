angular.module("wot").factory('TdParser', ['$http', 'CoAP',
    function TdParserFactory($http, CoAP) {
        var TdParser = {};

       
        
       
        var createThingfromOldTd =  function createThingfromOldTd(parsedTd) {
            var newThing = {
                'name': parsedTd.metadata.name,
                'properties': [],
                'actions': [],
                'uri': (parsedTd.metadata.protocols.HTTP) ? parsedTd.metadata.protocols.HTTP.uri : parsedTd.metadata.protocols.CoAP.uri, //FIXME dodgy
                'protocols': parsedTd.metadata.protocols
            };

            //add all properties
            parsedTd.interactions
                .filter(function isProperty(interaction) {
                    return interaction["@type"] == "Property";
                })
                .forEach(function addProperty(property) {
                    newThing.properties.push({
                        'name': property.name,
                        'writable': property.writable,
                        'xsdType': property.outputData,
                        'autoUpdate': false,
                        'history': [],
                        'parent': newThing
                        
                    });
                });

            //add actions
            parsedTd.interactions
                .filter(function isAction(interaction) {
                    return interaction["@type"] == "Action";
                })
                .forEach(function addAction(action) {
                    newThing.actions.push({
                        'name': action.name,
                        'xsdParamType': action.inputData,
                        'xsdReturnType': action.outputData,
                        'parent': newThing
                    });
                });

            return newThing;
        }

        var chooseUriIndex = function chooseUriIndex(uriArray) {
            prefIdx = -1;
            for(i=0;i<uriArray.length;i++) {
                var uri = uriArray[i];
                var scheme = uri.substring(0,uri.indexOf(':'));
                if(scheme === 'http')
                    return i;
                else if (scheme === 'coap')
                    prefIdx = i;
            };
            return prefIdx;
            
        }

        var pathConcat = function pathConcat(left, right) {
            if(left.slice(-1) === '/') {
               return left + right; 
            } else {
                return left + '/' + right;
            }
        }

        var createThingfromNewTd =  function createThingfromNewTd(parsedTd) {
            var uriArray = ( parsedTd.uris instanceof Array ) ? parsedTd.uris : [parsedTd.uris];
            var uriIndex = chooseUriIndex(uriArray);
            
            if(uriIndex === -1) throw Error("no suitable Protocols found")
            
            var newThing = {
                'name': parsedTd.name,
                'properties': [],
                'actions': [],
                'uri': uriArray[uriIndex],
				'context' : parsedTd['@context']
            };

            //add all properties
            if(parsedTd.properties) parsedTd.properties
                .forEach(function addProperty(property) {
                    
                    newThing.properties.push({
                        'name': property.name,
                        'writable': property.writable,
                        'type': property.valueType,
                        'uri': pathConcat(newThing.uri,property.hrefs[uriIndex]),
                        'autoUpdate': false,
						'unit' : property.unit,
                        'history': [],
                        'parent': newThing,
                        'properties': property.valueType['properties']
                    });
                 
                    
                
                });
            
            //add actions
            if(parsedTd.actions) parsedTd.actions
                .forEach(function addAction(action) {
                     var paramType = (action.inputData) ? action.inputData.valueType['type'] :"";
                    
                    newThing.actions.push({
                        'name': action.name,
                        'xsdParamType': paramType,
						'type': (action.inputData) ? action.inputData.valueType : "",
                        'inputProperties':(action.inputData) ? action.inputData.valueType['properties'] :"",
                        'xsdReturnType': (action.outputData)? action.outputData.valueType['type'] : "",
                        'parent': newThing,
                        'uri' : pathConcat(newThing.uri,action.hrefs[uriIndex])
                    });
                });

            return newThing;
        }

       TdParser.createThing = function dualParseTD(tdObj){
            if(tdObj.metadata)
                return createThingfromOldTd(tdObj);
               else
                return createThingfromNewTd(tdObj);
        }
		
		TdParser.extractValueTypesFromContext = function extractValueTypesFromContext(newThing){
			var contexts = newThing['context'];
			var nsArray = {};
			for (var c = 0; c < contexts.length; c++) {
				var context = contexts[c];
				var props = Object.keys(context);
				if (props.length == 1) {
					var ns = props[0];
					var url = context[ns];
					nsArray[url] = ns;
					$http.get(url).then(function(res) {
						var requestedUrl = res.config.url;
						TdParser.readContextCallback(res.data, nsArray[requestedUrl], newThing);
						return res.data
					})
				}
			}
			return newThing;			
		}
		
		TdParser.readContextCallback = function readContextCallback(data, ns, newThing) {
			//console.log(data);
			for (var i = 0; i < newThing.properties.length; i++) {
				var p = newThing.properties[i];
				var vt = p.type;
				var resolvedType = TdParser.recursiveResolveSchemaType(vt, ns, data);
				if(resolvedType)
					p.schema = resolvedType;
				//p.model = { "value": 0 };
			}
			for (var i = 0; i < newThing.actions.length; i++) {
				var a = newThing.actions[i];
				var vt = a.type;
				var resolvedType = TdParser.recursiveResolveSchemaType(vt, ns, data);
				if (resolvedType)
					a.schema = resolvedType;
				//a.model = {"value": [100,100]};
			}
			if(newThing.events){
				for (var i = 0; i < newThing.events.length; i++) {
					var e = newThing.events[i];
					var vt = e.type;
					var resolvedType = TdParser.recursiveResolveSchemaType(vt, ns, data);
					if (resolvedType)
						e.schema = resolvedType;
					//e.model = {};
				}
			}
		}

		TdParser.recursiveResolveSchemaType = function recursiveResolveSchemaType(type, namespace, schemaData) {
			if(type['$ref']){
				var referredSchema = type['$ref'];
				var parts = referredSchema.split(":");
				var prefix = parts[0];
				var typename = parts[1];
				if (referredSchema.startsWith("#/")) {
					prefix = namespace;
					typename = referredSchema.split("/")[1];
				}
				if(prefix == namespace){
					if (schemaData[typename]) {
						var containedType = schemaData[typename];
						if (containedType.properties) {
							for (var p in containedType.properties) {
								var t = containedType.properties[p];
								if(t['$ref'])
									containedType.properties[p] = TdParser.recursiveResolveSchemaType(t, namespace, schemaData);
							}
						}                  
						return containedType;
					}
					else {
						return "Error!";
					}
				} else {
					return null;
				}
			}
			else{
				return type;
			}
		} 

        TdParser.fromUrl = function fromUrl(url) {
            if (url.substring(0, 4) == 'coap') {
                return CoAP.get(url)
                    .then(function(res) {
                        return JSON.parse(res)
                    })
                    .then(TdParser.createThing)
            } else
                return $http.get(url).then(function(res) {
                    return res.data
                }).then(TdParser.createThing).then(TdParser.extractValueTypesFromContext)
        }

        TdParser.parseJson = function parseJson(json) {
            // TODO actually parse as JSON-LD, e.g. using io-informatics/angular-jsonld
            var td = JSON.parse(json);
            return TdParser.createThing(td);
        }

        return TdParser;
    }
]);

