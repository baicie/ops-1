//! Pure, side-effect-free transforms shared by the production Worker and the
//! Kernel Preview engine. No HTTP, database, filesystem or shell dependencies.
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{0}")]
pub struct TransformError(pub String);

fn err(message: impl Into<String>) -> TransformError {
    TransformError(message.into())
}

pub fn apply_mapping(records: Vec<Value>, config: &Value) -> Result<Vec<Value>, TransformError> {
    let mappings = config.get("mappings").and_then(Value::as_object);
    let Some(mappings) = mappings else {
        return records
            .into_iter()
            .map(|record| {
                let id = record
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| err("record id missing"))?;
                let name = record
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| err("record name missing"))?;
                Ok(json!({"id": id, "name": name}))
            })
            .collect();
    };
    records
        .into_iter()
        .map(|record| {
            let mut output = serde_json::Map::new();
            for (target, source) in mappings {
                let path = source
                    .as_str()
                    .ok_or_else(|| err("mapping source must be a string"))?;
                let value = path
                    .split('.')
                    .try_fold(&record, |current, segment| current.get(segment))
                    .cloned()
                    .ok_or_else(|| err(format!("mapping source {path} is missing")))?;
                output.insert(target.clone(), value);
            }
            Ok(Value::Object(output))
        })
        .collect()
}

pub fn apply_filter(records: Vec<Value>, config: &Value) -> Result<Vec<Value>, TransformError> {
    let Some(field) = config.get("field").and_then(Value::as_str) else {
        return Ok(records);
    };
    let op = config.get("op").and_then(Value::as_str).unwrap_or("eq");
    let expected = config.get("value").cloned().unwrap_or(Value::Null);
    Ok(records
        .into_iter()
        .filter(|record| {
            let actual = record.get(field).unwrap_or(&Value::Null);
            match op {
                "eq" => actual == &expected,
                "ne" => actual != &expected,
                "gt" => actual
                    .as_f64()
                    .zip(expected.as_f64())
                    .is_some_and(|(a, b)| a > b),
                "lt" => actual
                    .as_f64()
                    .zip(expected.as_f64())
                    .is_some_and(|(a, b)| a < b),
                "exists" => !actual.is_null(),
                _ => false,
            }
        })
        .collect())
}

pub fn validate_records(records: &[Value], config: &Value) -> Result<(), TransformError> {
    let required = config
        .get("required")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![Value::from("id"), Value::from("name")]);
    for record in records {
        if !record.is_object() {
            return Err(err("validated record is not an object"));
        }
        for field in &required {
            let field = field
                .as_str()
                .ok_or_else(|| err("required field must be a string"))?;
            if record.get(field).is_none_or(|value| value.is_null()) {
                return Err(err(format!("required field {field} is missing")));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mapping_filter_validate_are_deterministic() {
        let records = vec![
            json!({"id":"1","name":"a","n":2}),
            json!({"id":"2","name":"b","n":1}),
        ];
        let mapped =
            apply_mapping(records, &json!({"mappings":{"key":"id","label":"name"}})).unwrap();
        assert_eq!(mapped[0]["key"], "1");
        let filtered =
            apply_filter(mapped, &json!({"field":"label","op":"eq","value":"a"})).unwrap();
        assert_eq!(filtered.len(), 1);
        validate_records(&filtered, &json!({"required":["key","label"]})).unwrap();
    }

    #[test]
    fn invalid_config_is_explicit() {
        assert!(apply_mapping(vec![json!({"id":"1"})], &json!({"mappings":{"x":"id"}})).is_ok());
        assert!(apply_filter(vec![json!({})], &json!({"op":"bogus"})).is_ok());
        assert!(
            validate_records(&[json!({"id":"1"})], &json!({"required":["id","name"]})).is_err()
        );
    }
}
