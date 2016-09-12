function splitNoParens(s) {
	var parens = /\(|\)|\<|\-?\>/g;
	var result = s.split(",");
	for (var i = 0; i < result.length; i++) {
		do {
			var opens = 0;
			var find = null;
			while ((find = parens.exec(result[i])) !== null) {
				switch (find[0]) {
					case "(":
					case "<":
						opens++;
						break;
					case ")":
					case ">":
						opens--;
						break;
				}
			}
			if (i + 1 >= result.length) {
				break;
			}
			if (opens > 0) {
				result[i] += result.splice(i + 1, 1);
			}
		} while(opens);
		result[i] = result[i].trim();
    }
    return result;
}

function basicNameForStruct(structName) {
	return structName.match(/^\w+/)[0];
}

function Parser() {
	this.declarations = [];
	this.currentDeclaration = undefined;
	this.currentBasicBlock = undefined;
	// Lookback, to steal some unmangled name information that swiftc sticks in a comment
	this.lookbackLine = undefined;
}

Parser.caseNameForEnum = fullEnumName => fullEnumName.match(/^\w+\.(\w+)\!/)[1];

Parser.prototype.parseSil = function(line) {
	var name = line.split(/:/)[0].split(/\s+/).filter(part => /^@/.test(part))[0].substring(1);
	var conventionMatch = line.match(/\$\@convention\((\w+)\)\s/);
	var declaration = {
		name: name,
		type: "function",
		basicBlocks: [],
		localNames: {},
		convention: conventionMatch ? conventionMatch[1] : "swift"
	};
	if (!/\b(hidden|shared_external)\b/.test(line) && (declaration.convention != "method")) {
		if (!/^\/\/ specialized\s/.test(this.lookbackLine)) {
			var beautifulMatch = this.lookbackLine.match(/^\/\/ (\w+\.)?(\w+)/);
			if (beautifulMatch) {
				declaration.beautifulName = beautifulMatch[2];
			}
		}
	}
	if (/{$/.test(line)) {
		if (this.currentDeclaration) {
			throw "Already inside a declaration!";
		}
		this.currentDeclaration = declaration;
		this.currentBasicBlock = undefined;
	}
	this.declarations.push(declaration);
}

Parser.prototype.addLocalName = function (name, type, source) {
	if (type === undefined) {
		throw new Error("No type for %" + name + " in " + JSON.stringify(source));
	}
	var oldType = this.currentDeclaration.localNames[name];
	if (oldType === undefined) {
		this.currentDeclaration.localNames[name] = type;
	} else if (oldType != type) {
		throw new Error("Tried to replace type \"" + oldType + "\" with \"" + type + "\" for local %" + name + " in " + JSON.stringify(source));
	}
	this.currentBasicBlock.localNames[name] = type;
	return name;
}

Parser.prototype.parseBasicBlock = function(line) {
	if (!this.currentDeclaration) {
		throw "Found a basic block declaration outside of function declaration!";
	}
	var argMatch = line.match(/\((.*)\)/);
	if (argMatch) {
		var args = splitNoParens(argMatch[1]).map(arg => {
			var match = arg.match(/^%(\d+)\s+:\s+\$(.*)/)
			return {
				localName: match[1],
				type: match[2],
			};
		});
	}
	this.currentBasicBlock = {
		name: line.match(/^\w+\b/)[0],
		arguments: args || [],
		instructions: [],
		localNames: {},
	}
	this.currentDeclaration.basicBlocks.push(this.currentBasicBlock);
	this.currentBasicBlock.arguments.forEach(arg => this.addLocalName(arg.localName, arg.type, arg));
}

function simpleLocalContents(name, type) {
	return {
		interpretation: "contents",
		localNames: [name],
		type: type
	};
}

Parser.prototype.parseInstruction = function (line) {
	if (/^debug_value\s/.test(line)) {
		return;
	}
	if (/^debug_value_addr\s/.test(line)) {
		return;
	}
	if (/^retain_value\s+/.test(line)) {
		return;
	}
	if (/^release_value\s+/.test(line)) {
		return;
	}
	if (/^dealloc_stack\s+/.test(line)) {
		return;
	}
	if (/^dealloc_ref\s+/.test(line)) {
		return;
	}
	if (/^strong_retain\s+/.test(line)) {
		return;
	}
	if (/^strong_release\s+/.test(line)) {
		return;
	}
	if (line == "unreachable") {
		return {
			operation: "unreachable",
			inputs: []
		};
	}
	var match = line.match(/^\%(\w+)\s*=\s*(\w+)\s*(.*)/);
	if (match) {
		var destinationLocalName = match[1];
		var interpretation = match[2];
		var args = match[3];
		var input = {
			interpretation: interpretation,
			localNames: [],
			line: line,
		};
		switch (interpretation) {
			case "integer_literal":
				var match = args.match(/^\$(.*),\s+(.*)?$/);
				input.type = match[1];
				input.value = match[2];
				if (input.type == "Builtin.Int1") {
					input.value = input.value != 0;
				}
				break;
			case "float_literal":
				var match = args.match(/^\$(.*),\s+(.*)?$/);
				input.type = match[1];
				input.value = match[2];
				break;
			case "string_literal":
				input.value = args.match(/\".*\"/)[0];
				input.type = "Builtin.RawPointer";
				break;
			case "enum":
				var match = args.match(/^\$(.*),\s+.*?\.(\w+)\!.*?(,\s%(\d+) : \$(.*))?$/);
				input.type = basicNameForStruct(match[1]);
				input.caseName = match[2];
				if (match[4]) {
					input.localNames = [match[4]];
				}
				break;
			case "struct":
				var match = args.match(/^\$(.*?)\s+\((.*)\)/);
				input.type = basicNameForStruct(match[1]);
				input.localNames = splitNoParens(match[2]).map(arg => {
					var match = arg.match(/^%(\d+)\s*:\s*\$.*?\s*$/);
					return match[1];
					return {
						localName: match[1],
						type: match[2]
					}
				});
				break;
			case "tuple":
				var match = args.match(/^(\$\(.*?\)\s+)?\((.*)\)/);
				var descriptors = []
				if (match && match[2]) {
					descriptors = splitNoParens(match[2]).map(arg => {
						var match = arg.match(/^%(\d+)\s*:\s*\$(.*)$/);
						if (match) {
							return {
								localName: match[1],
								type: match[2],
							};
						} else {
							match = arg.match(/^%(\d+)$/);
							return {
								localName: match[1],
							};
						}
					});
				}
				input.localNames = descriptors.map(i => i.localName);
				input.type = "(" + descriptors.map(i => i.type).join(", ") + ")";
				break;
			case "struct_extract":
				var match = args.match(/^%(\d+)\s*:\s*\$(.*),\s*.*#.*\.(.*)$/);
				input.localNames = [match[1]];
				input.type = match[2];
				input.fieldName = match[3];
				break;
			case "tuple_extract":
				var match = args.match(/^%(\d+)\s*:\s*\$\((.*)\),\s+(\d+)$/);
				input.localNames = [match[1]];
				input.fieldName = match[3] | 0;
				input.type = splitNoParens(match[2])[input.fieldName];
				break;
			case "builtin":
				var match = args.match(/^\"(\w+)\"(<\w+>)?\((.*)\)\s*:\s*\$(.*)/);
				input.localNames = splitNoParens(match[3]).map(arg => {
					var match = arg.match(/^%(\d+)\s*:\s*\$(.*)$/)
					return match[1];
					return {
						localName: match[1],
						type: match[2]
					};
				});
				input.builtinName = match[1];
				input.type = match[4];
				break;
			case "function_ref":
				var match = args.match(/^@(\w+)\s*:\s*\$(.*)/);
				input.functionName = match[1];
				input.type = match[2]
				break;
			case "apply":
				var match = args.match(/^(\[nothrow\]\s+)?%(\d+)(<.*>)?\((.*)\)\s*:\s+\$(@convention\((\w+)\)\s+)?(.*)?\s+\-\>\s+(.*)/);
				var parameters = splitNoParens(match[4]).map(arg => {
					var match = arg.match(/^%(\d+)(#\d+)?$(.*)/)
					return match[1];
					// return {
					// 	localName: match[1],
					// 	type: match[3]
					// };
				});
				// parameters.unshift({
				// 	localName: match[2]
				// });
				parameters.unshift(match[2]);
				input.localNames = parameters;
				input.type = match[7];
				input.convention = match[6];
				break;
			case "partial_apply":
				var match = args.match(/^(\[nothrow\]\s+)?%(\d+)(<.*>)?\((.*)\)\s*:/);
				var parameters = splitNoParens(match[4]).map(arg => {
					var match = arg.match(/^%(\d+)(#\d+)?$(.*)/)
					return match[1]
					// return {
					// 	localName: match[1],
					// 	type: match[3]
					// };
				});
				// parameters.unshift({
				// 	localName: match[2]
				// });
				parameters.unshift(match[2]);
				input.localNames = parameters;
				input.type = "TODO";
				break;
			case "alloc_stack":
				var match = args.match(/^\$(.*)/);
				input.type = match[1];
				break;
			case "alloc_box":
				var match = args.match(/^\$(.*)?,/);
				input.type = match[1];
				break;
			case "alloc_ref":
				var match = args.match(/^\$(.*)/)
				input.type = match[1];
				break;
			case "project_box":
				var match = args.match(/^%(\w+)\s+:/);
				// assignment.inputs = [{
				// 	localName: match[1]
				// }];
				input.localNames = [match[1]];
				break;
			case "struct_element_addr":
				var match = args.match(/^%(\w+)(\#\d+)?\s+:\s+.*?#(\w+)\.(\w+)$/);
				// assignment.inputs = [{
				// 	localName: match[1],
				// 	type: match[3]
				// }];
				input.localNames = [match[1]];
				input.fieldName = match[4];
				input.type = match[3];
				break;
			case "ref_element_addr":
				var match = args.match(/%(\d+)\s+:.*#.*\.(.*)/)
				// assignment.inputs = [{
				// 	localName: match[1],
				// }];
				input.localNames = [match[1]];
				input.fieldName = match[2];
				input.type = "TODO";
				break;
			case "global_addr":
				var match = args.match(/^@(\w+)\s*:\s*(.*)/);
				input.globalName = match[1];
				input.type = match[2];
				break;
			case "load":
				var match = args.match(/^%(\w+)(#\d+)?\s+:\s*\$(.*)/);
				// assignment.inputs = [{
				// 	localName: match[1],
				// 	type: match[3]
				// }];
				input.localNames = [match[1]];
				input.type = match[3].substring(1);
				break;
			case "mark_uninitialized":
				var match = args.match(/^((\[\w+\]\s+)*)%(\w+)(#\d+)?\s+:\s\$*(.*)/);
				// assignment.inputs = [{
				// 	localName: match[3],
				// 	type: match[5]
				// }];
				input.localNames = match[3];
				input.type = match[5]
				input.interpretation = "contents";
				break;
			case "unchecked_enum_data":
				var match = args.match(/^%(\w+)\s+:\s*.*#(.*)\..*\!/);
				// assignment.inputs = [{
				// 	localName: match[1],
				// 	type: match[2]
				// }];
				input.localNames = [match[1]];
				input.type = match[2];
				break;
			case "select_enum":
				var match = args.match(/^%(\d+)\s+:\s+\$(.*?),\s+(case .*?)$/);
				var localNames = [match[1]];
				var cases = splitNoParens(match[3]).map(arg => {
					var match = arg.match(/^case\s+\#(.*):\s+%(\d+)( : .*)?$/);
					if (match) {
						localNames.push(match[2]);
						return {
							"case": match[1],
						};
					} else {
						match = arg.match(/^default\s+(.*)/);
						localNames.push(match[1]);
						return {
						};
					}
				})
				input.localNames = localNames;
				input.type = basicNameForStruct(match[2]);
				input.cases = cases;
				break;
			case "address_to_pointer":
			case "unchecked_ref_cast":
				var match = args.match(/^%(\w+)\s+:\s*\$(.*) to \$(.*)/);
				// assignment.inputs = [{
				// 	localName: match[1],
				// 	type: match[2],
				// }];
				input.localNames = [match[1]];
				input.type = match[3];
				input.interpretation = "contents";
				break;
			case "unchecked_addr_cast":
			case "pointer_to_address":
			case "ref_to_raw_pointer":
			case "raw_pointer_to_ref":
				var match = args.match(/^%(\d+)\s+:\s*(.*)/);
				// assignment.inputs = [{
				// 	localName: match[1],
				// 	type: match[2],
				// }];
				input.localNames = [match[1]];
				input.type = match[2];
				input.interpretation = "contents";
				break;
			case "thin_to_thick_function":
			case "convert_function":
				var match = args.match(/^%(\d+)\s+:\s+.* to \$(.*)/);
				// assignment.inputs = [{
				// 	localName: match[1],
				// }];
				input.localNames = [match[1]];
				input.type = [match[2]];
				input.interpretation = "contents";
				break;
			case "index_raw_pointer":
				input.localNames = splitNoParens(args).map(arg => {
					var match = args.match(/^%(\w+)\s+:\s*(.*)*/);
					return match[1];
				});
				input.type = "Builtin.RawPointer";
				break;
			case "index_addr":
				input.localNames = splitNoParens(args).map(arg => {
					var match = args.match(/^%(\w+)\s+:\s*(.*)*/);
					return match[1];
					// return {
					// 	localName: match[1],
					// 	type: match[2]
					// }
				});
				break;
			case "metatype":
				var match = args.match(/^\$(.*)/);
				input.type = match[1];
				break;
			case "upcast":
				var match = args.match(/^%(\d+)\s+:\s+\$(.*) to \$(.*)/);
				// assignment.inputs = [{
				// 	localName: match[1],
				// 	type: match[2],
				// }];
				input.localNames = [match[1]];
				input.type = match[3];
				input.interpretation = "contents";
				break;
			case "class_method":
				var match = args.match(/^%(\d+)\s+:\s+\$(.*?),\s+#(.*) : (.*)\s+,\s+\$@convention\((\w+)\)/);
				// assignment.inputs = [{
				// 	localName: match[1],
				// 	type: match[2],
				// }]
				input.localNames = [match[1]];
				input.type = match[4];
				input.entry = match[3];
				input.convention = match[5] || "swift";
				break;
			default:
				throw new Error("Unable to interpret " + input.interpretation + " from line: " + line);
				break;
		}
		var assignment = {
			operation: "assignment",
			destinationLocalName: destinationLocalName,
			inputs: [input],
		};
		this.addLocalName(assignment.destinationLocalName, input.type, assignment);
		return assignment;
	}
	match = line.match(/^return\s+\%(\d+)\s*:\s*\$(.*)/);
	if (match) {
		return {
			operation: "return",
			inputs: [simpleLocalContents(match[1], match[2])],
		};
	}
	match = line.match(/^br\s+(\w+)\((.*)\)/) || line.match(/^br\s+(\w+)/);
	if (match) {
		var inputs = match[2] ? splitNoParens(match[2]).map(arg => {
			var match = arg.match(/^%(\d+)\s*:\s*\$(.*)/);
			return simpleLocalContents(match[1], match[2]);
		}) : [];
		return {
			operation: "branch",
			block: { reference: match[1] },
			inputs: inputs,
		};
	}
	match = line.match(/^cond_br\s+\%(\d+),\s*(\w+),\s(\w+)/);
	if (match) {
		return {
			operation: "conditional_branch",
			inputs: [simpleLocalContents(match[1], undefined)],
			trueBlock: { reference: match[2] },
			falseBlock: { reference: match[3] },
		};
	}
	match = line.match(/^checked_cast_br\s+(\[exact\]\s+)?\%(\d+)\s+:.* to \$(.*),\s*(\w+),\s*(\w+)/);
	if (match) {
		// We don't do checked casts, assume that the argument type is always correct
		return {
			operation: "checked_cast_branch",
			inputs: [simpleLocalContents(match[2], undefined)], // No inputs
			trueBlock: { reference: match[4] },
			falseBlock: { reference: match[5] },
			type: match[3],
			exact: !!match[1],
		};
	}
	match = line.match(/^cond_fail\s+\%(\w+)\s+:/);
	if (match) {
		return {
			operation: "conditional_fail",
			inputs: [simpleLocalContents(match[1], undefined)],
		};
	}
	match = line.match(/^(store|assign)\s+\%(\w+)\s+to\s+\%(\w+)(\#\d+)?\s+:/);
	if (match) {
		return {
			operation: "store",
			inputs: [simpleLocalContents(match[2], undefined), simpleLocalContents(match[3])],
		};
	}
	match = line.match(/^copy_addr\s+\%(\w+)(\#\d+)?\s+to\s+(\[initialization\]\s+)?\%(\w+)(\#\d+)?\s+:/);
	if (match) {
		return {
			operation: "copy_addr",
			inputs: [simpleLocalContents(match[1], undefined), simpleLocalContents(match[4], undefined)],
		};
	}
	match = line.match(/^switch_enum\s+\%(\d+)\s+:\s+\$(.*?),\s+(case .*?)$/);
	if (match) {
		var cases = splitNoParens(match[3]).map(arg => {
			var match = arg.match(/^case\s+\#(.*):\s+(.*)$/);
			if (match) {
				return {
					"case": match[1],
					"basicBlock": { reference: match[2] }
				};
			} else {
				match = arg.match(/^default\s+(.*)/);
				return {
					"basicBlock": { reference: match[1] }
				};
			}
		})
		return {
			operation: "switch_enum",
			inputs: [simpleLocalContents(match[1], undefined)],
			cases: cases,
			type: basicNameForStruct(match[2]),
		};
	}
	match = line.match(/^try_apply\s+%(\w+)(<.*>)?\((.*)\)\s+:.*,\s+normal\s+(\w+),\s+error\s+(\w+)/);
	if (match) {
		var inputs = splitNoParens(match[3]).map(arg => {
			var match = arg.match(/^%(\d+)$/)
			return simpleLocalContents(match[1], undefined);
		});
		inputs.unshift(simpleLocalContents(match[1], undefined))
		return {
			operation: "try_apply",
			inputs: inputs,
			normalBlock: { reference: match[4] },
			errorBlock: { reference: match[5] },
		};
	}
	match = line.match(/^throw\s+%(\w+)\s*:/);
	if (match) {
		return {
			operation: "throw",
			inputs: [simpleLocalContents(match[1], undefined)],
		};
	}
	throw "Unknown instruction: " + line;
}

Parser.prototype.parseSilGlobal = function (line) {
	var declaration = {
		name: line.match(/\@(\w+)/)[1],
		type: "global",
	};
	this.declarations.push(declaration);
}

Parser.prototype.parseSilVTable = function (line) {
	var declaration = {
		name: line.match(/sil_vtable\s+(.*)\s+{/)[1],
		type: "vtable",
		entries: {}
	};
	this.declarations.push(declaration);
	this.currentDeclaration = declaration;
}

Parser.prototype.parseVTableMapping = function (line) {
	var match = line.match(/^\#(.*):\s+(.*)$/);
	this.currentDeclaration.entries[match[1]] = match[2];
}

Parser.prototype.addLine = function(originalLine) {
	line = originalLine.replace(/\s*\/\/.*/, "");
	if (line.length != 0) {
		var directive = line.match(/^\w+\b/);
		if (directive) {
			directive = directive[0];
			switch (directive) {
				case "sil_stage":
					// Do nothing with sil_stage directives
					break;
				case "import":
					// Do nothing with import directives
					break;
				case "sil":
					this.parseSil(line);
					break;
				case "sil_global":
					this.parseSilGlobal(line);
					break;
				case "sil_vtable":
					this.parseSilVTable(line);
					break;
				default:
					if (/^\w+(\(.*\))?:$/.test(line)) {
						// Found basic block!
						this.parseBasicBlock(line);
					}
					break;
			}
		} else if (/}$/.test(line)) {
			if (this.currentDeclaration) {
				this.currentDeclaration = undefined;
				this.currentBasicBlock = undefined;
			} else {
				// Not inside a declaration!
				// Should be an error, but we aren't even close to understanding Swift's protocols/method tables
			}
		} else if (/^  /.test(line)) {
			if (this.currentBasicBlock) {
				var instruction = this.parseInstruction(line.match(/^\s*(.*?)\s*(,? loc "\w+.\w+":\d+:\d+)?(,? scope \d+)?\s*$/)[1]);
				if (instruction) {
					this.currentBasicBlock.instructions.push(instruction);
				}
			} else if (this.currentDeclaration && this.currentDeclaration.type == "vtable") {
				this.parseVTableMapping(line.match(/^\s*(.*)$/)[1]);
			} else {
				// Not inside a declaration or basic block!
				// Should be an error, but we aren't even close to understanding Swift's protocols/method tables
			}
		} else {
			console.log("Unknown: " + line);
		}
	}
	this.lookbackLine = originalLine;
}

module.exports = Parser;